import { ipcMain } from 'electron'
import type { Browser, BrowserContext, Page } from 'playwright'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { browserManager } from '../managers/BrowserSessionManager'
import { orderSyncCoordinator } from '../services/OrderSyncCoordinator'
import { probeOpenOrderPages } from '../services/DoudianOrderPageProbe'
import { capturePendingOrderPages, ensureRecentSixMonthPartition, officialVariantMatchesVisibleLine, parseStructuredVariant, pendingCaptureFingerprint, type PendingOrderCapture } from '../services/DoudianPendingOrderReader'
import { observeOrderResponses, type OrderNetworkEvidence } from '../services/DoudianOrderNetworkCapture'
import { beijingDay, promisedShipDay } from '../services/DoudianDueDay'
import windowManager from '../windowManager'

const ORDER_LIST_URL = 'https://fxg.jinritemai.com/ffa/morder/order/list'
const LOGGED_IN_SELECTOR = '[class^="index_userName"]'
type Phase = 'disconnected' | 'opening' | 'browser-open' | 'login-required' | 'logged-in-unverified' | 'failed'
type Status = { accountId: string; phase: Phase; message: string; updatedAt: string }
type ShopSession = { browser: Browser; context: BrowserContext; timer: ReturnType<typeof setInterval> | null;
  landingAttempted: boolean; landingInProgress: boolean; pendingAttempted: boolean }
const sessions = new Map<string, ShopSession>()
const opening = new Set<string>()
const statuses = new Map<string, Status>()
const listeningPages = new WeakSet<Page>()
const organizing = new Set<string>()

type OrganizedRow = { shop_order_id: string; sku_order_id: string; product_id: string;
  product_name: string; merchant_code: string; color: string; size: string;
  variant_role: 'color' | 'raw_spec'; variant_review_reason: string;
  quantity: number; source_spec: string; status: string; promised_ship_day: string }

function shopIdFromEvidence(evidence: OrderNetworkEvidence[]): string | null {
  const ids = new Set<string>()
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(walk); return }
    const record = value as Record<string, unknown>
    const trace = record.trace_data as { shop_id?: unknown } | undefined
    if (trace && /^\d{5,}$/.test(String(trace.shop_id ?? ''))) ids.add(String(trace.shop_id))
    Object.values(record).forEach(walk)
  }
  evidence.filter(item => item.path.endsWith('/b/a/api/v1/reach/list')).forEach(item => walk(item.fields))
  return ids.size === 1 ? [...ids][0] : null
}

export function organizedRows(capture: PendingOrderCapture, evidence: OrderNetworkEvidence[]): OrganizedRow[] {
  const partition = capture.partitions[0]
  if (!capture.complete || !/^\d{5,}$/.test(String(capture.visibleShopId ?? '')) ||
      !partition || capture.partitions.length !== 1 || partition.key !== 'recent_6_months' ||
      partition.displayedPendingCount === null || !partition.endedAtLastPage)
    throw new Error('店铺身份、近6个月待发货范围或分页未读全')
  if (partition.displayedPendingCount === 0) {
    if (!partition.emptyStateConfirmed || partition.issues.length) throw new Error('0单未通过空表状态核对')
    return []
  }
  const products = new Map<string, { product_id: string; product_name: string; merchant_sku_code: string;
    official_item: Record<string, unknown>;
    variant: { color: string; size: string; role: 'color' | 'raw_spec' } | null;
    promisedShipDay: string }>()
  for (const response of evidence) {
    if (!response.path.endsWith('/api/order/searchlist')) continue
    const data = (response.fields as { data?: unknown }).data
    if (!Array.isArray(data)) continue
    if ((data as Array<Record<string, unknown>>).some(parent =>
      (parent.order_status_info as { order_status_text?: string } | undefined)?.order_status_text !== '待发货')) continue
    for (const parent of data as Array<Record<string, unknown>>) {
      const parentId = String(parent.shop_order_id ?? '')
      const dueDay = promisedShipDay(parent.exp_ship_time)
      for (const item of (parent.product_item as Array<Record<string, unknown>> | undefined) ?? []) {
        const childId = String(item.item_order_id ?? '')
        const childStatus = (item.sku_order_status_info as { order_status_text?: string } | undefined)?.order_status_text
        if (!/^\d{19}$/.test(parentId) || !/^\d{19}$/.test(childId) || childStatus !== '待发货')
          throw new Error('官方列表商品子订单编号或状态未核实')
        const key = `${parentId}:${childId}`
        if (products.has(key)) {
          if (products.get(key)?.promisedShipDay !== dueDay)
            throw new Error('同一商品子订单的承诺发货日期不一致；未生成当天订单')
          continue
        }
        products.set(key, { official_item: item, product_id: String(item.product_id ?? ''),
          product_name: String(item.product_name ?? ''), merchant_sku_code: String(item.merchant_sku_code ?? ''),
          variant: parseStructuredVariant(item), promisedShipDay: dueDay })
      }
    }
  }
  const lines = partition.pages.flatMap(page => page.lines)
  if (products.size === 0) throw new Error('本次未捕获可核验的官方待发货商品列表响应')
  const rows: OrganizedRow[] = []
  const seen = new Set<string>()
  let missingSpecification = 0
  let missingQuantity = 0
  for (const line of lines) {
    const childId = String(line.skuOrderId ?? '').slice(0, 19)
    const key = `${line.parentId}:${childId}`
    const item = products.get(key)
    // The shop sometimes renders an ancillary consumer remark as a duplicate row.
    if (!item) continue
    if (line.promisedShipAt && line.promisedShipAt.slice(0, 10) !== item.promisedShipDay)
      throw new Error('页面与官方承诺发货日期不一致；未生成当天订单')
    if (item.variant && !officialVariantMatchesVisibleLine(item.official_item, line, item.variant))
      throw new Error('官方商品规格与页面商品行不一致；未更新当天结果')
    const variant = item.variant ?? (line.color && line.size ? { color: line.color, size: line.size,
      role: line.variantRole ?? 'raw_spec' } : null)
    if (!variant) { missingSpecification++; continue }
    if (!Number.isInteger(line.quantity) || (line.quantity ?? 0) < 1) { missingQuantity++; continue }
    if (seen.has(key)) throw new Error('同一商品子订单存在多条有效商品行')
    if (!/^待发货/.test(line.orderStatus) || !/^\d+$/.test(item.product_id) || !item.product_name)
      throw new Error('商品状态或身份未核实')
    seen.add(key)
    rows.push({ shop_order_id: line.parentId, sku_order_id: childId,
      product_id: item.product_id, product_name: item.product_name,
      merchant_code: item.merchant_sku_code, color: variant.color, size: variant.size,
      variant_role: variant.role,
      variant_review_reason: variant.role === 'color' ? '' : '平台未标注颜色或款式类型；按原始规格展示',
      quantity: line.quantity!, source_spec: line.productName, status: '待发货',
      promised_ship_day: item.promisedShipDay })
  }
  if (rows.length !== products.size || new Set(rows.map(row => row.shop_order_id)).size !== partition.displayedPendingCount ||
      partition.pages.reduce((sum, page) => sum + page.parentCount, 0) !== partition.displayedPendingCount)
    throw new Error(`页面商品行与官方列表响应未能逐项对应：页面主订单 ${partition.displayedPendingCount}、官方商品子订单 ${products.size}、成功对应 ${rows.length}、规格待核 ${missingSpecification}、数量待核 ${missingQuantity}`)
  return rows
}

type PendingView = { available: true; scope: 'pending_and_today_due'; observed_at: string; day: string;
  page_complete: true; displayed_parent_count: number; source_pending_count: number;
  shop_id_verified: string; account_bound: true; rows: OrganizedRow[] }
const pendingViews = new Map<string, PendingView>()

function publishOrganized(accountId: string, capture: PendingOrderCapture, rows: OrganizedRow[]): PendingView {
  const day = beijingDay(new Date(capture.finishedAt))
  const output: PendingView = { available: true, scope: 'pending_and_today_due', observed_at: capture.finishedAt,
    day, page_complete: true, displayed_parent_count: new Set(rows.map(row => row.shop_order_id)).size,
    source_pending_count: capture.partitions[0].displayedPendingCount!,
    shop_id_verified: capture.visibleShopId!, account_bound: true, rows }
  pendingViews.set(accountId, output)
  return output
}

function pendingView(accountId: string): PendingView | { available: false } {
  const view = pendingViews.get(accountId)
  if (!view || view.day !== beijingDay(new Date())) {
    pendingViews.delete(accountId)
    return { available: false }
  }
  return view
}

function publish(accountId: string, phase: Phase, message: string) {
  const previous = statuses.get(accountId)
  if (previous?.phase === phase && previous.message === message) return previous
  const status = { accountId, phase, message, updatedAt: new Date().toISOString() }
  statuses.set(accountId, status)
  windowManager.send(IPC_CHANNELS.orderExport.status, status)
  if (phase === 'logged-in-unverified' && previous?.phase !== phase) {
    orderSyncCoordinator.onAuthenticated(accountId, 'shop')
  } else if (phase === 'login-required' && previous?.phase === 'logged-in-unverified') {
    orderSyncCoordinator.cancel(accountId, 'shop')
  }
  return status
}

function statusOf(accountId: string): Status {
  return statuses.get(accountId) ?? {
    accountId, phase: 'disconnected', message: '尚未连接店铺后台。', updatedAt: new Date().toISOString(),
  }
}

async function inspectLogin(accountId: string) {
  const session = sessions.get(accountId)
  if (!session) return statusOf(accountId)
  if (!session.context.pages().some(page => !page.isClosed())) return closeSession(accountId)
  let sawLoginPage = false
  for (const page of session.context.pages()) {
    if (page.isClosed()) continue
    let url: URL
    try { url = new URL(page.url()) } catch { continue }
    if (url.origin !== 'https://fxg.jinritemai.com') continue
    if (url.pathname.startsWith('/login/')) {
      sawLoginPage = true
      continue
    }
    try {
      if (await page.locator(LOGGED_IN_SELECTOR).count() > 0) {
        if (url.pathname !== '/ffa/morder/order/list' && !session.landingAttempted && !session.landingInProgress) {
          session.landingAttempted = true
          session.landingInProgress = true
          try { await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }) }
          catch { /* Keep the official page available; the user can retry with the open button. */ }
          finally { session.landingInProgress = false }
        }
        if (page.url().startsWith(ORDER_LIST_URL) && !session.pendingAttempted) {
          try {
            const recent = page.getByText(/^近\s*6\s*个月订单$/).first()
            const pending = page.getByRole('tab', { name: /待发货/ }).first()
            if (await recent.count() > 0 && await recent.isVisible() && await pending.count() > 0) {
              await ensureRecentSixMonthPartition(page)
              if (await pending.getAttribute('aria-selected') !== 'true') await pending.click({ timeout: 5000 })
              session.pendingAttempted = true
            }
          } catch { /* Wait for the order tabs to finish loading; the next check retries. */ }
        }
        return publish(accountId, 'logged-in-unverified',
          session.pendingAttempted
            ? '已打开订单列表的待发货页；近6个月范围、店铺 ID 和完整性仍待核验。'
            : '已检测到抖店登录；正在打开订单列表的待发货页。')
      }
    } catch { /* Page can navigate while being checked; retry on the next probe. */ }
  }
  if (sawLoginPage) {
    session.landingAttempted = false
    session.pendingAttempted = false
    return publish(accountId, 'login-required', '检测到抖店登录页；请在官方页面自行登录，登录后自动打开订单列表。')
  }
  if (statusOf(accountId).phase === 'logged-in-unverified') return statusOf(accountId)
  return publish(accountId, 'browser-open', '店铺浏览器会话已创建，但未确认窗口可见或已登录；请点击“打开店铺后台”。')
}

function attachPage(accountId: string, page: Page) {
  if (listeningPages.has(page)) return
  listeningPages.add(page)
  page.on('load', () => { void inspectLogin(accountId) })
  page.on('close', () => {
    const session = sessions.get(accountId)
    if (session && !session.context.pages().some(candidate => !candidate.isClosed()))
      void closeSession(accountId)
  })
  page.on('download', async download => {
    await download.cancel().catch(() => undefined)
    windowManager.send(IPC_CHANNELS.orderExport.downloaded, { accountId, ok: false,
      filename: download.suggestedFilename(), savedAt: '', localPath: '',
      message: '工作台仅在本次运行期间展示待发货订单；不保存订单报表下载。' })
  })
}

async function closeSession(accountId: string) {
  const session = sessions.get(accountId)
  sessions.delete(accountId)
  pendingViews.delete(accountId)
  if (session?.timer) clearInterval(session.timer)
  if (session) await session.browser.close().catch(() => undefined)
  orderSyncCoordinator.cancel(accountId, 'shop')
  return publish(accountId, 'disconnected', '店铺后台浏览器已断开。')
}

export function setupOrderExportIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.orderExport.getPendingView, (_event, accountId: string) => pendingView(accountId))
  ipcMain.handle(IPC_CHANNELS.orderExport.getPlacement, () =>
    ({ ok: false, message: '当天应发模式不保存本机下单确认记录。' }))
  ipcMain.handle(IPC_CHANNELS.orderExport.confirmPlacement, () =>
    ({ ok: false, message: '当天应发模式已停用本机下单确认。' }))
  ipcMain.handle(IPC_CHANNELS.orderExport.undoPlacement, () =>
    ({ ok: false, message: '当天应发模式没有可撤销的本机下单记录。' }))
  ipcMain.handle(IPC_CHANNELS.orderExport.getStatus, (_event, accountId: string) => statusOf(accountId))
  ipcMain.handle(IPC_CHANNELS.orderExport.check, (_event, accountId: string) => inspectLogin(accountId))
  ipcMain.handle(IPC_CHANNELS.orderExport.probeOrderPage, async (_event, accountId: string) => {
    const session = sessions.get(accountId)
    return probeOpenOrderPages(session?.context.pages() ?? [])
  })
  ipcMain.handle(IPC_CHANNELS.orderExport.capturePendingRows, async (_event, accountId: string) => {
    const session = sessions.get(accountId)
    if (!session || statusOf(accountId).phase !== 'logged-in-unverified')
      return { ok: false, message: '店铺会话未登录；未读取订单。' }
    const page = session.context.pages().find(candidate => !candidate.isClosed() &&
      candidate.url().startsWith('https://fxg.jinritemai.com/ffa/morder/order/list'))
    if (!page) return { ok: false, message: '当前会话未找到抖店订单列表页；未读取订单。' }
    const stopObserving = observeOrderResponses(page)
    try {
      const capture = await capturePendingOrderPages(page)
      await stopObserving()
      const parents = capture.partitions.reduce((n, part) => n + part.pages.reduce((m, current) => m + current.parentCount, 0), 0)
      const lines = capture.partitions.reduce((n, part) => n + part.pages.reduce((m, current) => m + current.lines.length, 0), 0)
      return { ok: true, message: '候选订单行已只读检查，未保存订单内容。',
        parents, lines, pages: capture.partitions.map(part => part.pages.length), issues: capture.issues.slice(0, 20) }
    } catch (error) {
      await stopObserving().catch(() => undefined)
      return { ok: false, message: `只读采集停止：${error instanceof Error ? error.message : '未知错误'}；未保存订单。` }
    }
  })
  ipcMain.handle(IPC_CHANNELS.orderExport.organizePending, async (_event, accountId: string) => {
    const session = sessions.get(accountId)
    if (!session || statusOf(accountId).phase !== 'logged-in-unverified')
      return { ok: false, message: '店铺后台未登录；未更新当天结果。' }
    const page = session.context.pages().find(candidate => !candidate.isClosed() &&
      candidate.url().startsWith(ORDER_LIST_URL))
    if (!page) return { ok: false, message: '未找到官方订单列表页；未更新当天结果。' }
    if (organizing.has(accountId)) return { ok: false, message: '已有一次订单整理正在进行。' }
    organizing.add(accountId)
    const stopObserving = observeOrderResponses(page)
    try {
      // A click on an already selected tab can reuse cached rows without a list response.
      // Reload under observation so non-empty rows can be checked against the official response.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.getByText(/^近\s*6\s*个月订单$/).first()
        .waitFor({ state: 'visible', timeout: 30000 })
      await ensureRecentSixMonthPartition(page)
      await page.getByRole('tab', { name: /待发货/ }).first()
        .waitFor({ state: 'visible', timeout: 30000 })
      const capture = await capturePendingOrderPages(page)
      const check = await capturePendingOrderPages(page)
      const evidence = await stopObserving()
      if (pendingCaptureFingerprint(capture) !== pendingCaptureFingerprint(check))
        throw new Error('两次逐页读取的订单身份、状态或数量不一致；未更新当天结果')
      const observedShopId = shopIdFromEvidence(evidence)
      if (capture.visibleShopId && observedShopId && capture.visibleShopId !== observedShopId)
        throw new Error('页面与官方会话中的店铺 ID 不一致；未更新当天结果')
      capture.visibleShopId = capture.visibleShopId ?? observedShopId
      capture.complete = Boolean(capture.visibleShopId)
      let rows: OrganizedRow[]
      rows = organizedRows(capture, evidence)
      const view = publishOrganized(accountId, capture, rows)
      const todayRows = view.rows.filter(row => row.promised_ship_day === view.day)
      return { ok: true, parents: view.displayed_parent_count, children: view.rows.length,
        quantity: view.rows.reduce((sum, row) => sum + row.quantity, 0),
        empty: view.rows.length === 0, observedAt: capture.finishedAt,
        message: `全部待发货：${view.displayed_parent_count} 个主订单、${view.rows.length} 个商品子订单；今日应发 ${new Set(todayRows.map(row => row.shop_order_id)).size} 个主订单。来源已核对 ${view.source_pending_count} 个待发货主订单，本机不保存订单内容。` }
    } catch (error) {
      await stopObserving().catch(() => undefined)
      return { ok: false, message: `订单整理未通过核对：${error instanceof Error ? error.message : '未知错误'}；未保存订单。` }
    } finally { organizing.delete(accountId) }
  })
  ipcMain.handle(IPC_CHANNELS.orderExport.open, async (_event, accountId: string, chromePath?: string) => {
    if (!accountId || accountId.length > 100 || !/^[\w-]+$/.test(accountId)) {
      return publish(accountId || '', 'failed', '账号标识无效，未打开浏览器。')
    }
    const existing = sessions.get(accountId)
    if (existing) {
      const page = existing.context.pages().find(candidate => !candidate.isClosed() &&
        candidate.url().startsWith('https://fxg.jinritemai.com/ffa/morder/order/list')) ??
        existing.context.pages().find(candidate => !candidate.isClosed())
      if (page) {
        await page.bringToFront().catch(() => undefined)
        existing.landingAttempted = false
        return inspectLogin(accountId)
      }
      await closeSession(accountId)
    }
    if (opening.has(accountId)) return statusOf(accountId)
    opening.add(accountId)
    publish(accountId, 'opening', '正在打开独立的店铺后台浏览器…')
    try {
      if (chromePath) browserManager.setChromePath(chromePath)
      const created = await browserManager.createSession(false)
      const session: ShopSession = { browser: created.browser, context: created.context, timer: null,
        landingAttempted: false, landingInProgress: false, pendingAttempted: false }
      sessions.set(accountId, session)
      created.context.on('page', page => attachPage(accountId, page))
      attachPage(accountId, created.page)
      created.browser.on('disconnected', () => {
        if (sessions.get(accountId) !== session) return
        sessions.delete(accountId)
        pendingViews.delete(accountId)
        if (session.timer) clearInterval(session.timer)
        orderSyncCoordinator.cancel(accountId, 'shop')
        publish(accountId, 'disconnected', '店铺后台浏览器已关闭。')
      })
      await created.page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded' })
      session.timer = setInterval(() => { void inspectLogin(accountId) }, 2000)
      return inspectLogin(accountId)
    } catch {
      await closeSession(accountId)
      return publish(accountId, 'failed', '店铺后台浏览器打开失败；未执行订单操作。')
    } finally {
      opening.delete(accountId)
    }
  })
  ipcMain.handle(IPC_CHANNELS.orderExport.close, (_event, accountId: string) => closeSession(accountId))
}
