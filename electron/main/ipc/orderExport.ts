import { randomUUID } from 'node:crypto'
import { mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'
import { app, ipcMain } from 'electron'
import type { Browser, BrowserContext, Page } from 'playwright'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { browserManager } from '../managers/BrowserSessionManager'
import windowManager from '../windowManager'

const ORDER_PORTAL = 'https://fxg.jinritemai.com/'
let session: { browser: Browser; context: BrowserContext } | null = null
const listeningPages = new WeakSet<Page>()

function attachDownloadListener(page: Page) {
  if (listeningPages.has(page)) return
  listeningPages.add(page)
  page.on('download', async download => {
    const filename = download.suggestedFilename().replace(/[\\/]/g, '_')
    const result = { ok: false, filename, savedAt: '', localPath: '', message: '' }
    try {
      // A downloaded ZIP/CSV is only a candidate; the workbench must verify its
      // report identity, scope, headers and rows before importing anything.
      const origin = new URL(page.url()).origin
      if (origin !== 'https://fxg.jinritemai.com' || !/\.(zip|csv)$/i.test(filename)) {
        result.message = '下载来源或格式不是已识别的抖店订单报表，未保存到订单收件箱。'
      } else {
        const inbox = path.join(app.getPath('userData'), 'OrderReports')
        await mkdir(inbox, { recursive: true, mode: 0o700 })
        const target = path.join(inbox, `${randomUUID()}_${filename}`)
        await download.saveAs(target)
        await chmod(target, 0o600)
        result.ok = true
        result.localPath = target
        result.savedAt = new Date().toISOString()
        result.message = '报表候选文件已下载；尚未核对筛选范围或导入订单。'
      }
    } catch {
      result.message = '报表下载未完成；请在官方页面检查下载状态。'
    }
    windowManager.send(IPC_CHANNELS.orderExport.downloaded, result)
  })
}

export function setupOrderExportIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.orderExport.open, async () => {
    if (session) return { ok: true, message: '订单后台浏览器已打开。请在官方页面自行登录和操作。' }
    try {
      const created = await browserManager.createSession(false)
      session = { browser: created.browser, context: created.context }
      created.context.on('page', attachDownloadListener)
      attachDownloadListener(created.page)
      created.browser.on('disconnected', () => { session = null })
      await created.page.goto(ORDER_PORTAL)
      return { ok: true, message: '抖店官方页面已打开。请自行登录并核对订单筛选与导出。' }
    } catch {
      if (session) await session.browser.close().catch(() => undefined)
      session = null
      return { ok: false, message: '无法打开订单后台浏览器；未执行订单操作。' }
    }
  })
  ipcMain.handle(IPC_CHANNELS.orderExport.close, async () => {
    const old = session
    session = null
    if (old) await old.browser.close().catch(() => undefined)
  })
}
