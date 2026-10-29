import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell } from 'electron'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { emitter } from './event/eventBus'
import { updateManager } from './managers/UpdateManager'
import { providerService } from './services/ProviderService'
import windowManager from './windowManager'
import './ipc'
import { createLogger } from './logger'
import { accountManager } from './managers/AccountManager'

// const _require = createRequire(import.meta.url)

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//

function createBoxedString(lines: string[]) {
  // 1. 计算最长的一行文字长度
  const maxLength = Math.max(...lines.map(line => line.length))

  // 2. 定义边框样式
  // 顶部和底部边框 (例如: +----------------+)
  const horizontalLine = `+${'-'.repeat(maxLength + 2)}+`

  // 3. 生成中间的内容行
  const content = lines
    .map(line => {
      // 使用 padEnd 补齐空格，使得右边框对齐
      return `| ${line.padEnd(maxLength)} |`
    })
    .join('\n')

  // 4. 拼接结果
  return `\n${horizontalLine}\n${content}\n${horizontalLine}`
}

function logStartupInfo() {
  const appInfo = [
    `App Name:     ${app.getName()}`,
    `App Version:  ${app.getVersion()}`,
    `Electron Ver: ${process.versions.electron}`,
    `Node Ver:     ${process.versions.node}`,
    `Platform:     ${process.platform} (${process.arch})`,
    `Environment:  ${app.isPackaged ? 'Production' : 'Development'}`,
  ]
  const logger = createLogger('startup')
  logger.debug(createBoxedString(appInfo))
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// Disable GPU Acceleration for Windows 7
if (os.release().startsWith('6.1')) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

// Keep the independent desktop app's state separate from older OBA installs.
// This also gives it its own single-instance lock and starts with no saved tasks.
if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), '线上经营工具'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null
let workbenchView: WebContentsView | null = null
let workbenchVisible = false
let lastWorkbenchRequestKey = ''
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')
const configuredPort = Number(process.env.TUTIANDUO_PORT || 8765)
let workbenchPort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort : 8765
let workbenchOrigin = `http://127.0.0.1:${workbenchPort}`
let workbenchProcess: ChildProcess | null = null
let workbenchServiceReady = false

async function availableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('本机端口不可用')); return }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

async function startWorkbenchService() {
  if (!app.isPackaged) return
  // The old local prototype may already own 8765. Never attach this app to
  // another process or require the user to stop their existing workbench.
  workbenchPort = await availableLoopbackPort()
  workbenchOrigin = `http://127.0.0.1:${workbenchPort}`
  const dataDir = path.join(app.getPath('userData'), 'workbench-data')
  const executable = path.join(process.resourcesPath, 'workbench',
    process.platform === 'win32' ? 'tutianduo-workbench.exe' : 'tutianduo-workbench')
  const healthy = async () => {
    try {
      const response = await fetch(`${workbenchOrigin}/api/health`, { signal: AbortSignal.timeout(1000) })
      const state = await response.json() as { service?: string; data_dir?: string }
      return response.ok && state.service === 'tutianduo-order-workbench' && state.data_dir === dataDir
    } catch { return false }
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  workbenchProcess = spawn(executable, [], {
    env: { ...process.env, TUTIANDUO_DATA_DIR: dataDir, TUTIANDUO_PORT: String(workbenchPort) },
    stdio: 'ignore',
  })
  workbenchProcess.on('error', error => createLogger('workbench').error('本机订单服务启动失败', error))
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await healthy()) { workbenchServiceReady = true; return }
    if (workbenchProcess.exitCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  createLogger('workbench').warn('本机订单服务未就绪；请检查 Python 运行环境或端口占用')
}
const workbenchPages = new Set([
  '/', '/due', '/shipped', '/sales', '/stock', '/history', '/history-sku', '/imports', '/import',
])

function showWorkbench(bounds: { x: number; y: number; width: number; height: number; viewportWidth: number; path: string; requestKey: string; preservePath?: string }) {
  if (!win || win.isDestroyed() || !workbenchServiceReady) return
  const [contentWidth, contentHeight] = win.getContentSize()
  const values = [bounds.x, bounds.y, bounds.width, bounds.height, bounds.viewportWidth]
  if (!values.every(value => Number.isFinite(value) && Number.isInteger(value))) return
  if (bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1 || bounds.viewportWidth < 1) return
  if (!workbenchPages.has(bounds.path)) return
  // Renderer CSS pixels can differ from BrowserWindow content coordinates when
  // the user has zoomed the UI. Scale the native child view into the same space.
  const scale = contentWidth / bounds.viewportWidth
  const x = Math.round(bounds.x * scale)
  const y = Math.round(bounds.y * scale)
  if (x >= contentWidth || y >= contentHeight) return
  const visibleBounds = { x, y,
    width: Math.min(Math.max(1, Math.round(bounds.width * scale)), contentWidth - x),
    height: Math.min(Math.max(1, Math.round(bounds.height * scale)), contentHeight - y) }

  if (!workbenchView) {
    workbenchView = new WebContentsView({
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    workbenchView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    workbenchView.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${workbenchOrigin}/`)) event.preventDefault()
    })
    workbenchView.webContents.on('did-finish-load', () => {
      void workbenchView?.webContents.insertCSS('.sidebar{display:none!important}.app-shell{display:block!important}')
    })
    workbenchView.webContents.on('did-navigate', (_event, url) => {
      if (!url.startsWith(`${workbenchOrigin}/`)) return
      win?.webContents.send(IPC_CHANNELS.workbench.navigated, { path: new URL(url).pathname })
    })
    void workbenchView.webContents.loadURL(`${workbenchOrigin}${bounds.path}`).catch(error => {
      createLogger('workbench').warn('本机订单服务尚不可用', error)
    })
  } else if (bounds.requestKey !== lastWorkbenchRequestKey) {
    const currentUrl = workbenchView.webContents.getURL()
    const currentPath = currentUrl.startsWith(`${workbenchOrigin}/`) ? new URL(currentUrl).pathname : ''
    if (currentPath !== bounds.path && currentPath !== bounds.preservePath) {
      void workbenchView.webContents.loadURL(`${workbenchOrigin}${bounds.path}`).catch(error => {
        createLogger('workbench').warn('本机订单页面尚不可用', error)
      })
    }
  }
  lastWorkbenchRequestKey = bounds.requestKey
  if (!workbenchVisible) {
    win.contentView.addChildView(workbenchView)
    workbenchVisible = true
  }
  workbenchView.setBounds(visibleBounds)
}

ipcMain.handle(IPC_CHANNELS.workbench.show, (event, bounds) => {
  if (event.sender !== win?.webContents) return
  showWorkbench(bounds)
})

ipcMain.handle(IPC_CHANNELS.workbench.hide, (event, requestKey: string) => {
  if (event.sender !== win?.webContents || !win || !workbenchView || !workbenchVisible ||
      requestKey !== lastWorkbenchRequestKey) return
  win.contentView.removeChildView(workbenchView)
  workbenchVisible = false
})

ipcMain.handle(IPC_CHANNELS.workbench.reloadDue, event => {
  if (event.sender !== win?.webContents || !workbenchView) return false
  const current = workbenchView.webContents.getURL()
  if (!current.startsWith(`${workbenchOrigin}/due`)) return false
  workbenchView.webContents.reload()
  return true
})

async function createWindow() {
  win = new BrowserWindow({
    title: `线上经营工具 - v${app.getVersion()}`,
    width: 1280,
    height: 800,
    autoHideMenuBar: app.isPackaged,
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    webPreferences: {
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // nodeIntegration: true,
      nodeIntegration: process.env.NODE_ENV === 'development',
      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      // contextIsolation: false,
    },
  })

  windowManager.setMainWindow(win)
  win.on('closed', () => {
    workbenchView = null
    workbenchVisible = false
    lastWorkbenchRequestKey = ''
  })

  if (VITE_DEV_SERVER_URL) {
    // #298
    win.loadURL(VITE_DEV_SERVER_URL)
    // Open devTool if the app is not packaged
    win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }

  // 加载完成后检查更新
  win.webContents.on('did-finish-load', async () => {
    await updateManager.silentCheckForUpdate()
  })

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 当返回最新 providers 时推送到渲染进程
  emitter.on('providers-updated', providers => {
    win?.webContents.send(IPC_CHANNELS.app.providersUpdated, providers)
  })
}

app
  .whenReady()
  // Today-due mode keeps order rows in the Electron process only. The legacy
  // local order service can import and persist orders, so do not start it.
  .then(logStartupInfo)
  .then(() => providerService.initialize())
  .then(createWindow)

app.on('window-all-closed', async () => {
  win = null
  accountManager.cleanup()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => { workbenchProcess?.kill() })

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})

process.on('uncaughtException', error => {
  const logger = createLogger('uncaughtException')
  logger.error('--------------意外的未捕获异常---------------')
  logger.error(error)
  logger.error('---------------------------------------------')

  dialog.showErrorBox(
    '应用程序错误',
    `发生了一个意外的错误，请前往 Github Issue 页面反馈：\n${error.message}`,
  )
})

process.on('unhandledRejection', reason => {
  // playwright-extra 插件问题：在 browser.close() 时概率触发
  // https://github.com/berstend/puppeteer-extra/issues/858
  const logger = createLogger('unhandledRejection')
  if (
    reason instanceof Error &&
    reason.message.includes('cdpSession.send: Target page, context or browser has been closed')
  ) {
    return logger.verbose(reason)
  }

  logger.error('--------------未被处理的错误---------------')
  logger.error(reason)
  logger.error('-------------------------------------------')
})

// New window example arg: new windows url
ipcMain.handle('open-win', (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`)
  } else {
    childWindow.loadFile(indexHtml, { hash: arg })
  }
})
