import type { Page } from 'playwright'

const ORDER_URL = 'https://fxg.jinritemai.com/ffa/morder/order/list'
const MAX_PAGES = 100
const LEGACY_COMBINED_COLORS = ['肤色', '黑色', '深灰', '浅灰', '花紫黑', '花驼灰']
const SIZE_TOKEN = /^(?:\d{1,2}XL|[2-9]XS|XS|S|M|L|XL|均码|通码|[\p{Script=Han}]{1,10}(?:码|号)|\d{2,3}(?:cm|厘米|码)|\d{2,3}[-~～]\d{2,3}(?:cm|厘米|码)?)$/iu
const COLOR_HINT = /(?:色|灰|黑|白|红|蓝|绿|黄|紫|粉|咖|驼|棕|米|青|金)$/u

export type VisibleOrderLine = {
  parentId: string
  placedAt: string | null
  skuOrderId: string | null
  merchantCode: string | null
  productName: string
  color: string | null
  size: string | null
  variantRole: 'color' | 'raw_spec' | null
  quantity: number | null
  aftersaleStatus: string
  orderStatus: string
  promisedShipAt: string | null
  issues: string[]
}

export type CapturedPage = { number: number; parentCount: number; lines: VisibleOrderLine[] }
export type CapturedPartition = {
  key: 'recent_6_months'
  displayedPendingCount: number | null
  pages: CapturedPage[]
  endedAtLastPage: boolean
  emptyStateConfirmed?: boolean
  issues: string[]
}
export type PendingOrderCapture = {
  sourceUrl: string
  visibleShopId: string | null
  startedAt: string
  finishedAt: string
  partitions: CapturedPartition[]
  complete: boolean
  issues: string[]
}

/** The page appends a live shipping countdown to the stable pending status. */
export function pendingCaptureFingerprint(capture: PendingOrderCapture): string {
  return JSON.stringify(capture.partitions.map(partition => ({
    count: partition.displayedPendingCount,
    lastPage: partition.endedAtLastPage,
    pages: partition.pages.map(page => ({ number: page.number, parents: page.parentCount,
      lines: page.lines.map(line => [line.parentId, line.skuOrderId, line.productName,
        line.quantity, line.orderStatus.startsWith('待发货') ? '待发货' : line.orderStatus,
        line.aftersaleStatus]) })),
  })))
}

type RawRow = { className: string; rowKey?: string; cells: string[]; statusTitles?: string[] }

async function waitForPendingListResponse(page: Page): Promise<string[]> {
  const response = await page.waitForResponse(async candidate => {
    try {
      const url = new URL(candidate.url())
      if (url.hostname !== 'fxg.jinritemai.com' || !url.pathname.endsWith('/api/order/searchlist') ||
          candidate.status() !== 200) return false
      const body = await candidate.json() as { data?: Array<Record<string, unknown>> }
      return Array.isArray(body.data) && body.data.every(parent =>
        (parent.order_status_info as { order_status_text?: string } | undefined)?.order_status_text === '待发货')
    } catch { return false }
  }, { timeout: 30000 })
  const body = await response.json() as { data: Array<Record<string, unknown>> }
  const ids = body.data.map(parent => String(parent.shop_order_id ?? ''))
  if (ids.some(id => !/^\d{19}$/.test(id)) || new Set(ids).size !== ids.length)
    throw new Error('官方待发货列表的主订单编号无效或重复')
  return ids
}

async function waitForMatchingTable(page: Page, expectedIds: string[]): Promise<void> {
  await page.waitForFunction(expected => {
    if (document.querySelector('.auxo-spin-spinning')) return false
    const parents = Array.from(document.querySelectorAll('tr.auxo-table-row-level-0'))
    const actual = parents.map(row => row.querySelector('td:nth-child(2)')?.textContent?.match(/\d{19}/)?.[0] ?? '')
    return actual.length === expected.length && actual.every((id, index) => id === expected[index])
  }, expectedIds, { timeout: 30000 })
}

function onlyDigits(value: string): string | null {
  return value.match(/\d{15,}/)?.[0] ?? null
}

/** Read named SKU dimensions from a sanitized official order-list item. */
export function parseStructuredVariant(item: Record<string, unknown>): { color: string; size: string; role: 'color' | 'raw_spec' } | null {
  const found: { color: Set<string>; size: Set<string> } = { color: new Set(), size: new Set() }
  let explicitColor = false
  let rawSpecRole: 'color' | 'raw_spec' = 'raw_spec'
  const add = (role: string, value: unknown) => {
    if (typeof value !== 'string' && typeof value !== 'number') return
    const text = String(value).trim()
    if (!text || text.length > 64) return
    if (/^(?:color|color_name|sku_color|颜色|颜色分类|色号)$/iu.test(role)) {
      found.color.add(text)
      explicitColor = true
    }
    if (/^(?:size|size_name|sku_size|尺码|尺码大小|尺寸|大小)$/iu.test(role)) {
      // The official SKU dimension can append a weight guide, e.g. XL(110-130斤).
      // Keep the original value in the review evidence and use only its size token here.
      const size = text.split(/[（(]/u, 1)[0].trim()
      found.size.add(SIZE_TOKEN.test(size)
        ? (/^(?:[2-9]?XL|[2-9]?XS|S|M|L)$/iu.test(size) ? size.toUpperCase() : size)
        : text)
    }
  }
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(entry => walk(entry, depth + 1)); return }
    const record = value as Record<string, unknown>
    const name = record.name ?? record.spec_name ?? record.property_name ?? record.attribute_name ?? record.key ?? record.title
    const namedValue = record.value ?? record.spec_value ?? record.property_value ?? record.attribute_value ?? record.val
    if (typeof name === 'string') add(name, namedValue)
    for (const [key, child] of Object.entries(record)) {
      add(key, child)
      if (/(?:spec|property|attribute)/iu.test(key) && typeof child === 'string' && child.length <= 64) {
        const parsed = parseColorSize(`规格: ${child}`)
        if (parsed) { found.color.add(parsed.color); found.size.add(parsed.size); rawSpecRole = parsed.role }
      }
      if (/(?:spec|property|properties|attribute)/iu.test(key) && child && typeof child === 'object') walk(child, depth + 1)
    }
  }
  walk(item, 0)
  if (found.color.size !== 1 || found.size.size !== 1) return null
  return { color: [...found.color][0], size: [...found.size][0], role: explicitColor ? 'color' : rawSpecRole }
}

function parseColorSize(item: string): { color: string; size: string; role: 'color' | 'raw_spec' } | null {
  const text = item.split(/\s+x\s*\d+\s*(?:商家编码|带货达人|商品单|$)/i)[0]
  const labeledColor = text.match(/(?:颜色|颜色分类)\s*[:：]\s*([^,，;；\s]{1,24})/u)?.[1]
  const labeledSize = text.match(/(?:尺码|尺寸|大小)\s*[:：]\s*([^,，;；\s]{1,24})/u)?.[1]
  if (labeledColor && labeledSize) return { color: labeledColor, size: labeledSize, role: 'color' }
  if (labeledColor || labeledSize) return null
  // The order page displays an unlabelled variant as a distinct token after
  // the title, e.g. "【单裤】花驼灰/4XL(男180-200斤)". Do not search title prose.
  const variants: Array<{ color: string; size: string; role: 'color' | 'raw_spec' }> = []
  const pattern = /[】\]\s,，;；:：]([^/／\s,，;；:：()（）【】\[\]]{1,24})\s*[/／]\s*([^/／\s,，;；:：()（）【】\[\]]{1,24})(?=[\s(（,，;；]|$)/gu
  for (const match of text.matchAll(pattern)) {
    const color = match[1].trim()
    const size = match[2].trim()
    if (!color || !SIZE_TOKEN.test(size) || /^\d+$/u.test(color)) continue
    variants.push({ color, size: /^(?:[2-9]?XL|[2-9]?XS|S|M|L)$/iu.test(size) ? size.toUpperCase() : size,
      role: COLOR_HINT.test(color) ? 'color' : 'raw_spec' })
  }
  if (variants.length) return variants.length === 1 ? variants[0] : null
  // Older page layouts concatenate a two-colour token with the title. Keep
  // that narrow legacy form; new standalone variants use the rule above.
  for (const first of LEGACY_COMBINED_COLORS) {
    for (const second of LEGACY_COMBINED_COLORS) {
      const match = text.match(new RegExp(`${first}\\s*[+＋]\\s*${second}\\s*[/／]\\s*(\\d{1,2}XL|[2-9]XS|XS|S|M|L|XL)(?![A-Za-z0-9])`, 'i'))
      if (match) variants.push({ color: `${first}+${second}`, size: match[1].toUpperCase(), role: 'color' })
    }
  }
  if (variants.length) return variants.length === 1 ? variants[0] : null
  // Some product titles end with a numbered style marker immediately followed
  // by the SKU variant: "...-09巧克力色/3XL". The marker gives a safe boundary.
  const numberedSuffix = [...text.matchAll(/[-－]\d{1,4}([\p{Script=Han}A-Za-z0-9+＋－-]{1,24})\s*[/／]\s*([^/／\s,，;；:：()（）]{1,16})(?=[\s(（,，;；]|$)/gu)]
    .map(match => ({ color: match[1], size: match[2] }))
    .filter(variant => SIZE_TOKEN.test(variant.size))
  if (numberedSuffix.length !== 1) return null
  return { color: numberedSuffix[0].color, role: COLOR_HINT.test(numberedSuffix[0].color) ? 'color' : 'raw_spec',
    size: /^(?:[2-9]?XL|[2-9]?XS|S|M|L)$/iu.test(numberedSuffix[0].size)
      ? numberedSuffix[0].size.toUpperCase() : numberedSuffix[0].size }
}

/** Parse only merchant and item cells. The shipping-address cell is never read. */
export function parseVisibleRows(rows: RawRow[]): { parentCount: number; lines: VisibleOrderLine[]; issues: string[] } {
  let parentId: string | null = null
  let placedAt: string | null = null
  let parentCount = 0
  const lines: VisibleOrderLine[] = []
  const issues: string[] = []
  for (const row of rows) {
    if (/auxo-table-row-level-0/.test(row.className)) {
      parentId = onlyDigits(row.cells[1] || '')
      placedAt = (row.cells[1] || '').match(/下单时间\s*(\d{4}-\d\d-\d\d\s+\d\d:\d\d:\d\d)/)?.[1] ?? null
      parentCount++
      if (!parentId) issues.push('主订单行缺少订单编号')
      continue
    }
    if (!/auxo-table-row-level-1/.test(row.className)) continue
    const item = row.cells[1] || ''
    const quantityMatch = item.match(/x\s*(\d+)\s*(?:商家编码|带货达人|商品单|$)/i)
    const priceQuantity = (row.cells[2] || '').match(/x\s*(\d+)/i)
    // The page flattens merchant code and the following seller/item labels
    // without separators. This is diagnostic only; the official item response
    // supplies the authoritative merchant_sku_code.
    const merchantCode = item.match(/商家编码\s*[:：]\s*([A-Za-z0-9_-]+)/iu)?.[1] ?? null
    // The shop page sometimes concatenates the next quantity digit to its 19-digit item ID.
    // The response cross-check below remains the authority for the exact ID.
    const skuOrderId = item.match(/(?:商品单(?:ID)?|子订单编号|子订单号)\s*[:：]?\s*(\d{19})/)?.[1]
      ?? (row.rowKey && /^\d{15,}$/.test(row.rowKey) ? row.rowKey : null)
    if (!skuOrderId && !quantityMatch && !priceQuantity) continue
    const colorSize = parseColorSize(item)
    const productName = item.split(/x\s*\d+\s*(?:商家编码|带货达人|商品单)/i)[0]?.trim() || ''
    const orderStatus = row.cells[4] || ''
    const aftersaleStatus = row.cells[3] || ''
    const exactPromise = [orderStatus, ...(row.statusTitles || [])].join(' ')
      .match(/(?:承诺发货(?:时间)?|最晚发货(?:时间)?)\s*[:：]?\s*(\d{4}[-/]\d\d[-/]\d\d\s+\d\d:\d\d(?::\d\d)?)/)?.[1]
    const lineIssues: string[] = []
    if (!parentId) lineIssues.push('无法关联主订单')
    if (!skuOrderId) lineIssues.push('页面未见商品子订单编号')
    // Blank merchant codes are kept blank; product ID and name identify these items.
    if (!colorSize) lineIssues.push('无法确认颜色或尺码')
    if (!quantityMatch) lineIssues.push('无法确认商品数量')
    if (quantityMatch && priceQuantity && quantityMatch[1] !== priceQuantity[1]) lineIssues.push('商品行数量与价格列数量不一致')
    if (!/^待发货/.test(orderStatus)) lineIssues.push('商品行状态非明确待发货')
    if (aftersaleStatus && aftersaleStatus !== '-' && !aftersaleStatus.includes('小件运费险')) lineIssues.push('售后状态待核')
    if (!exactPromise) lineIssues.push('页面仅显示发货倒计时，尚未核实绝对承诺发货时间')
    lines.push({ parentId: parentId || '', placedAt, skuOrderId, merchantCode, productName,
      color: colorSize?.color ?? null, size: colorSize?.size ?? null,
      variantRole: colorSize?.role ?? null,
      quantity: quantityMatch ? Number(quantityMatch[1]) : null,
      aftersaleStatus, orderStatus, promisedShipAt: exactPromise?.replaceAll('/', '-') ?? null, issues: lineIssues })
  }
  if (parentCount && !lines.length) issues.push('本页有主订单但未读到商品子订单')
  return { parentCount, lines, issues }
}

function currentUrlIsOrderPage(page: Page): boolean {
  try {
    const url = new URL(page.url())
    return `${url.origin}${url.pathname}` === ORDER_URL
  } catch { return false }
}

/** Read only the recent-six-month pending partition requested by the user. */
export async function capturePendingOrderPages(page: Page): Promise<PendingOrderCapture> {
  if (!currentUrlIsOrderPage(page)) throw new Error('当前不是抖店官方订单列表页')
  const result: PendingOrderCapture = { sourceUrl: ORDER_URL, visibleShopId: null, startedAt: new Date().toISOString(),
    finishedAt: '', partitions: [], complete: false, issues: [] }
  result.visibleShopId = await page.locator('body').evaluate(node =>
    node.textContent?.match(/(?:店铺\s*ID|店铺编号)\s*[:：]\s*(\d{5,})/)?.[1] ?? null)
  const partitions = [['recent_6_months', /近\s*6\s*个月订单/]] as const
  for (const [key, label] of partitions) {
    const tab = page.getByRole('tab', { name: label }).first()
    if (await tab.count() !== 1) {
      result.partitions.push({ key, displayedPendingCount: null, pages: [], endedAtLastPage: false,
        issues: [`${key} 时间分区未找到；此分区未采集`] })
      continue
    }
    await tab.click()
    await page.locator('.auxo-spin-spinning').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => undefined)
    const pending = page.getByRole('tab', { name: /待发货/ }).first()
    const partition: CapturedPartition = { key, displayedPendingCount: null,
      pages: [], endedAtLastPage: false, issues: [] }
    if (await pending.count() !== 1) {
      partition.issues.push(`${key} 未显示待发货状态标签；不能把全部订单当成待发货`)
      result.partitions.push(partition)
      continue
    }
    // An already selected pending tab can reuse cached rows. Switch through
    // the official all-status tab so the pending list emits a fresh response
    // for the item-by-item cross-check in organizePending.
    const wasPendingSelected = await pending.evaluate(node => node.getAttribute('aria-selected') === 'true' ||
      Boolean(node.closest('.auxo-tabs-tab-active')))
    if (wasPendingSelected) {
      const alternateStatus = pending.locator('xpath=ancestor::*[contains(@class,"auxo-tabs-nav-list")][1]')
        .locator('.auxo-tabs-tab').filter({ hasNotText: /待发货/ }).first()
      if (await alternateStatus.count() !== 1) {
        partition.issues.push('待发货标签已选中，但未找到同组其他状态标签以刷新官方列表响应')
        result.partitions.push(partition)
        continue
      }
      await alternateStatus.click({ timeout: 5000 })
      await page.locator('.auxo-spin-spinning').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => undefined)
    }
    const firstResponse = waitForPendingListResponse(page)
    try { await pending.click({ timeout: 5000 }) } catch {
      await firstResponse.catch(() => undefined)
      partition.issues.push(`${key} 待发货状态标签切换时消失；此分区未采集`)
      result.partitions.push(partition)
      continue
    }
    let expectedPageIds = await firstResponse
    await page.locator('.auxo-spin-spinning').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => undefined)
    const pendingText = await pending.innerText({ timeout: 5000 }).catch(() => '')
    if (!pendingText) {
      partition.issues.push(`${key} 待发货状态标签读取时消失；此分区未采集`)
      result.partitions.push(partition)
      continue
    }
    const displayedPendingCount = Number(pendingText.match(/待发货\s*(\d+)/)?.[1])
    partition.displayedPendingCount = Number.isFinite(displayedPendingCount) ? displayedPendingCount : null
    const pendingSelected = await pending.evaluate(node => node.getAttribute('aria-selected') === 'true' ||
      Boolean(node.closest('.auxo-tabs-tab-active')))
    if (!pendingSelected) partition.issues.push('未证明待发货筛选处于选中状态')
    if (displayedPendingCount === 0) {
      if (expectedPageIds.length !== 0) partition.issues.push('页面显示0单，但官方列表响应仍有订单')
      const recentSelected = await tab.evaluate(node => node.getAttribute('aria-selected') === 'true' ||
        Boolean(node.closest('.auxo-tabs-tab-active')))
      const emptyText = await page.locator('tr.auxo-table-placeholder').first().innerText().catch(() => '')
      partition.emptyStateConfirmed = pendingSelected && recentSelected && /暂无数据/.test(emptyText) &&
        await page.locator('tr.auxo-table-row-level-0').count() === 0
      if (!partition.emptyStateConfirmed) partition.issues.push('页面显示0单，但时间分区、筛选或空表状态未共同确认')
      partition.pages.push({ number: 1, parentCount: 0, lines: [] })
      partition.endedAtLastPage = true
      result.partitions.push(partition)
      continue
    }
    if (expectedPageIds.length === 0) throw new Error('页面显示待发货订单，但官方列表响应为空')
    // The status count can change before the table. Match every displayed parent
    // against the response from this particular filter/page navigation.
    await waitForMatchingTable(page, expectedPageIds)
    const seen = new Set<string>()
    for (let number = 1; number <= MAX_PAGES; number++) {
      if (!currentUrlIsOrderPage(page)) throw new Error('读取过程中离开了官方订单列表页')
      await waitForMatchingTable(page, expectedPageIds)
      // The status-tab count and pagination can advance before the table rows
      // finish changing. An old all-status page may contain paid or closed
      // orders while the pending tab already displays its new count.
      await page.waitForFunction(() => {
        if (document.querySelector('.auxo-spin-spinning')) return false
        const parents = document.querySelectorAll('tr.auxo-table-row-level-0')
        const children = document.querySelectorAll('tr.auxo-table-row-level-1')
        return parents.length > 0 && children.length > 0 && Array.from(children).every(row => {
          const status = row.querySelectorAll(':scope > td')[4]?.textContent?.trim() || ''
          return status.startsWith('待发货')
        })
      }, undefined, { timeout: 30000 })
      const raw = await page.locator('table tbody tr').evaluateAll(elements => elements.map(row => ({
        className: row.className,
        rowKey: row.getAttribute('data-row-key') || '',
        cells: Array.from(row.querySelectorAll(':scope > td')).slice(0, 5).map(cell => cell.textContent?.replace(/\s+/g, ' ').trim() || ''),
        statusTitles: Array.from(row.querySelectorAll(':scope > td:nth-child(5) [title], :scope > td:nth-child(5) [aria-label]'))
          .map(node => node.getAttribute('title') || node.getAttribute('aria-label') || '').slice(0, 6),
      })))
      const parsed = parseVisibleRows(raw)
      for (const line of parsed.lines) {
        const key = `${line.parentId}:${line.skuOrderId || line.productName}`
        if (seen.has(key)) partition.issues.push(`商品行跨页重复：${key}`)
        seen.add(key)
      }
      partition.pages.push({ number, parentCount: parsed.parentCount, lines: parsed.lines })
      partition.issues.push(...parsed.issues)
      const observedSoFar = partition.pages.reduce((sum, current) => sum + current.parentCount, 0)
      if (partition.displayedPendingCount !== null && observedSoFar === partition.displayedPendingCount) {
        partition.endedAtLastPage = true
        break
      }
      const next = page.locator('li.auxo-pagination-next').first()
      const nextReady = await page.waitForFunction(() => {
        const node = document.querySelector('li.auxo-pagination-next')
        return Boolean(node && !node.classList.contains('auxo-pagination-disabled') &&
          node.getAttribute('aria-disabled') !== 'true' && !node.querySelector('button:disabled'))
      }, undefined, { timeout: 15000 }).then(() => true).catch(() => false)
      if (!nextReady) {
        partition.issues.push(`页面显示 ${partition.displayedPendingCount} 个待发货主订单，已读 ${observedSoFar} 个，但下一页不可用`)
        break
      }
      const active = page.locator('li.auxo-pagination-item-active').first()
      const before = await active.innerText().catch(() => String(number))
      const nextResponse = waitForPendingListResponse(page)
      await next.locator('button').click()
      expectedPageIds = await nextResponse
      await page.waitForFunction(previous => {
        const active = document.querySelector('li.auxo-pagination-item-active')
        return active?.textContent?.trim() !== previous
      }, before, { timeout: 15000 })
      await waitForMatchingTable(page, expectedPageIds)
    }
    if (!partition.endedAtLastPage && partition.pages.length >= MAX_PAGES)
      partition.issues.push(`达到 ${MAX_PAGES} 页安全上限，未证明完整`)
    const observedParents = partition.pages.reduce((sum, current) => sum + current.parentCount, 0)
    if (partition.displayedPendingCount !== null && partition.displayedPendingCount !== observedParents)
      partition.issues.push(`主订单数不符：页面 ${partition.displayedPendingCount}，读取 ${observedParents}`)
    result.partitions.push(partition)
  }
  result.finishedAt = new Date().toISOString()
  result.issues = result.partitions.flatMap(partition => partition.issues)
  if (!result.visibleShopId) result.issues.push('订单页面未显示可核验的店铺 ID')
  if (result.partitions.some(part => part.pages.some(current => current.lines.some(line => line.issues.length))))
    result.issues.push('商品行仍有字段待核，不能发布完整尺码矩阵')
  result.issues.push('本次仅核对近6个月待发货；尚未完成读取前后状态一致性复核，不能发布为已验证快照')
  return result
}
