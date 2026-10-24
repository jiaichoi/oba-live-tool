import { randomUUID } from 'node:crypto'
import { mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'
import { app, ipcMain } from 'electron'
import type { Browser, BrowserContext, Page } from 'playwright'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { browserManager } from '../managers/BrowserSessionManager'
import { orderSyncCoordinator } from '../services/OrderSyncCoordinator'
import windowManager from '../windowManager'

const ORDER_PORTAL = 'https://fxg.jinritemai.com/'
const LOGGED_IN_SELECTOR = '[class^="index_userName"]'
type Phase = 'disconnected' | 'opening' | 'browser-open' | 'login-required' | 'logged-in-unverified' | 'failed'
type Status = { accountId: string; phase: Phase; message: string; updatedAt: string }
type ShopSession = { browser: Browser; context: BrowserContext; timer: ReturnType<typeof setInterval> | null }
const sessions = new Map<string, ShopSession>()
const opening = new Set<string>()
const statuses = new Map<string, Status>()
const listeningPages = new WeakSet<Page>()

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
        return publish(accountId, 'logged-in-unverified',
          '已检测到抖店登录；订单权限、店铺 ID 和待发货完整性仍待核验，尚未同步。')
      }
    } catch { /* Page can navigate while being checked; retry on the next probe. */ }
  }
  if (sawLoginPage) return publish(accountId, 'login-required', '抖店登录页已打开，请在浏览器中自行登录。')
  if (statusOf(accountId).phase === 'logged-in-unverified') return statusOf(accountId)
  return publish(accountId, 'browser-open', '店铺浏览器已打开，尚未检测到登录；请在浏览器中完成登录。')
}

function attachPage(accountId: string, page: Page) {
  if (listeningPages.has(page)) return
  listeningPages.add(page)
  page.on('load', () => { void inspectLogin(accountId) })
  page.on('download', async download => {
    const filename = download.suggestedFilename().replace(/[\\/]/g, '_')
    const result = { accountId, ok: false, filename, savedAt: '', localPath: '', message: '' }
    try {
      const origin = new URL(page.url()).origin
      if (origin !== 'https://fxg.jinritemai.com' || !/\.(zip|csv)$/i.test(filename)) {
        result.message = '下载来源或格式不是已识别的抖店订单报表，未保存到订单收件箱。'
      } else {
        const inbox = path.join(app.getPath('userData'), 'OrderReports', accountId)
        await mkdir(inbox, { recursive: true, mode: 0o700 })
        const target = path.join(inbox, `${randomUUID()}_${filename}`)
        await download.saveAs(target)
        await chmod(target, 0o600)
        result.ok = true
        result.localPath = target
        result.savedAt = new Date().toISOString()
        result.message = '报表候选文件已下载；尚未核对店铺、筛选范围或导入订单。'
      }
    } catch {
      result.message = '报表下载未完成；请在官方页面检查下载状态。'
    }
    windowManager.send(IPC_CHANNELS.orderExport.downloaded, result)
  })
}

async function closeSession(accountId: string) {
  const session = sessions.get(accountId)
  sessions.delete(accountId)
  if (session?.timer) clearInterval(session.timer)
  if (session) await session.browser.close().catch(() => undefined)
  orderSyncCoordinator.cancel(accountId, 'shop')
  return publish(accountId, 'disconnected', '店铺后台浏览器已断开。')
}

export function setupOrderExportIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.orderExport.getStatus, (_event, accountId: string) => statusOf(accountId))
  ipcMain.handle(IPC_CHANNELS.orderExport.check, (_event, accountId: string) => inspectLogin(accountId))
  ipcMain.handle(IPC_CHANNELS.orderExport.open, async (_event, accountId: string, chromePath?: string) => {
    if (!accountId || accountId.length > 100 || !/^[\w-]+$/.test(accountId)) {
      return publish(accountId || '', 'failed', '账号标识无效，未打开浏览器。')
    }
    if (sessions.has(accountId)) return inspectLogin(accountId)
    if (opening.has(accountId)) return statusOf(accountId)
    opening.add(accountId)
    publish(accountId, 'opening', '正在打开独立的店铺后台浏览器…')
    try {
      if (chromePath) browserManager.setChromePath(chromePath)
      const created = await browserManager.createSession(false)
      const session: ShopSession = { browser: created.browser, context: created.context, timer: null }
      sessions.set(accountId, session)
      created.context.on('page', page => attachPage(accountId, page))
      attachPage(accountId, created.page)
      created.browser.on('disconnected', () => {
        if (sessions.get(accountId) !== session) return
        sessions.delete(accountId)
        if (session.timer) clearInterval(session.timer)
        orderSyncCoordinator.cancel(accountId, 'shop')
        publish(accountId, 'disconnected', '店铺后台浏览器已关闭。')
      })
      await created.page.goto(ORDER_PORTAL, { waitUntil: 'domcontentloaded' })
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
