import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:os'
import path from 'node:path'
import { app, net, shell } from 'electron'
import type { AppUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import { marked } from 'marked'
import semver from 'semver'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import * as yaml from 'yaml'
import windowManager from '#/windowManager'
import { createLogger } from '../logger'
import { errorMessage, sleep } from '../utils'

type LatestYml = {
  version: string
  files: Array<{
    url: string
    sha512: string
    size: number
  }>
  path: string
  sha512: string
  releaseDate: string
}

const GITHUB_OWNER = 'jiaichoi'
const GITHUB_REPO = 'oba-live-tool'
const PRODUCT_NAME = '线上经营工具'

const logger = createLogger('update')

// marked 生成的 html 要在新页面打开链接
marked.use({
  renderer: {
    link: ({ href, title, text }) => {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer"${title ? ` title="${title}"` : ''}>${text}</a>`
    },
  },
})

async function timeoutFetch(url: string | URL, timeout = 5000) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await net.fetch(url.toString(), {
      signal: controller.signal,
      // 不加上 User-Agent 会访问超时
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    })
    clearTimeout(timeoutId)
    return response
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Fetch timeout')
    }
    throw err
  }
}

const releaseNotes: Record<string, string> = {}
let latestVersion: string | null = null

async function getLatestVersion() {
  try {
    // 只有本仓库实际发布的安装包才可作为更新来源；main 分支可能仍是上游版本。
    const response = await timeoutFetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    )
    if (!response.ok) return null
    const release = (await response.json()) as {
      tag_name?: string
      body?: string
      assets?: Array<{ name: string }>
    }
    const version = release.tag_name?.replace(/^v/, '')
    if (!version || !semver.valid(version) || !release.assets?.length) return null
    releaseNotes[version] = await marked.parse(release.body ?? '')
    latestVersion = version
    return version
  } catch (error) {
    logger.debug('本仓库尚无可用的正式发布版本', error)
    return null
  }
}

async function fetchChangelog() {
  return latestVersion ? releaseNotes[latestVersion] : undefined
}

function getAssetsURL() {
  const assetsURL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${latestVersion}/`
  return assetsURL
}

interface Updater {
  checkForUpdates(source: string): Promise<void>
  downloadUpdate(): void
  quitAndInstall(): void
}

class UpdateManager {
  constructor(private updater: Updater) {}

  public async checkForUpdates(source = 'github') {
    const version = await getLatestVersion()
    if (!version || !semver.gt(version, app.getVersion())) {
      windowManager.send(IPC_CHANNELS.updater.updateAvailable, {
        update: false,
        version: app.getVersion(),
        newVersion: app.getVersion(),
      })
      return
    }
    await this.updater.checkForUpdates(source)
  }

  public async checkUpdateVersion() {
    const latestVersion = await getLatestVersion()
    if (!latestVersion) {
      return
    }
    const currentVersion = app.getVersion()
    if (semver.lt(currentVersion, latestVersion)) {
      // 先用 log 提示更新
      logger.info(
        `检查到可用更新：${currentVersion} -> ${latestVersion}，可前往应用设置-软件更新处手动更新`,
      )
      const releaseNote = await fetchChangelog()

      return {
        currentVersion,
        latestVersion,
        releaseNote,
      }
    }
  }

  public async silentCheckForUpdate() {
    try {
      const result = await this.checkUpdateVersion()
      if (result) {
        windowManager.send(IPC_CHANNELS.app.notifyUpdate, { ...result })
      }
    } catch (err) {
      logger.debug(`静默检查更新失败：${err}`)
    }
  }

  public startDownload() {
    logger.info('开始下载更新……')
    this.updater.downloadUpdate()
  }

  public async quitAndInstall() {
    logger.info('准备退出并安装更新')
    this.updater.quitAndInstall()
  }
}

class WindowsUpdater implements Updater {
  private autoUpdater: AppUpdater
  constructor() {
    const { autoUpdater }: { autoUpdater: AppUpdater } = createRequire(import.meta.url)(
      'electron-updater',
    )
    this.autoUpdater = autoUpdater
    this.configureUpdater()
    this.registerEventListener()
  }

  private configureUpdater() {
    this.autoUpdater.forceDevUpdateConfig = true
    this.autoUpdater.disableWebInstaller = false
    this.autoUpdater.allowDowngrade = false
  }

  private registerEventListener() {
    this.autoUpdater.on('checking-for-update', () => {
      logger.debug('检查更新流程已启动...')
    })

    this.autoUpdater.on('update-available', async (info: UpdateInfo) => {
      logger.info(`有可用更新！当前版本：${app.getVersion()}，新版本：${info.version}`)

      const releaseNote = await fetchChangelog()
      windowManager.send(IPC_CHANNELS.updater.updateAvailable, {
        update: true,
        version: app.getVersion(),
        newVersion: info.version,
        releaseNote,
      })
    })

    this.autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      logger.info(`无可用更新。当前版本：${app.getVersion()}，新版本：${info.version}`)
      windowManager.send(IPC_CHANNELS.updater.updateAvailable, {
        update: false,
        version: app.getVersion(),
        newVersion: info.version,
      })
    })

    this.autoUpdater.on('download-progress', (progressInfo: ProgressInfo) => {
      windowManager.send(IPC_CHANNELS.updater.downloadProgress, progressInfo)
    })

    this.autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      logger.info(`${event.version} 更新下载完成!`)
      windowManager.send(IPC_CHANNELS.updater.updateDownloaded, event)
    })

    this.autoUpdater.on('error', (error: Error) => {
      logger.error('更新出错: ', error.message)
      windowManager.send(IPC_CHANNELS.updater.updateError, {
        message: error.message,
        error,
      })
    })
  }

  private async checkUpdateForGithub() {
    // github 不需要关闭 noCache，requestHeaders 默认就是 null
    this.autoUpdater.requestHeaders = null
    this.autoUpdater.setFeedURL({
      provider: 'github',
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
    })
    return this.autoUpdater.checkForUpdates()
  }

  private async checkUpdateForGhProxy(source: string) {
    let sourceURL: URL
    try {
      sourceURL = new URL(source)
    } catch {
      const msg = `更新源设置错误，你的更新源为 ${source}`
      throw new Error(msg)
    }
    const assetsURL = getAssetsURL()
    // 自定义更新源
    this.autoUpdater.setFeedURL({
      provider: 'generic',
      url: `${sourceURL}${assetsURL}`,
    })
    try {
      return await this.autoUpdater.checkForUpdates()
    } catch (error) {
      const message = `网络错误: ${errorMessage(error).split('\n')[0]}`
      const downloadURL = `${sourceURL}${assetsURL}${PRODUCT_NAME}_${latestVersion}_windows_x64.exe`
      windowManager.send(IPC_CHANNELS.updater.updateError, { message, downloadURL })
    }
  }

  public async checkForUpdates(source: string) {
    // 默认情况会在请求的资源 URL 后面添加查询参数 noCache
    // 但是很多 proxy 站点并没有针对 query 优化，就会导致 404
    // 本身通过 proxy 访问的 URL 就带有版本号，所以 noCache 完全没作用
    // 通过下面的 hack 可以不附带 noCache 查询
    // https://github.com/electron-userland/electron-builder/issues/3415#issuecomment-433082387
    this.autoUpdater.requestHeaders = { authorization: '' }
    try {
      if (!app.isPackaged) {
        if (!this.autoUpdater.forceDevUpdateConfig) {
          const message = '更新功能仅在应用打包后可用。'
          windowManager.send(IPC_CHANNELS.updater.updateError, { message })
          return
        }
        // 开发环境下的更新，要先启动 slow-server (pnpm slow-server)
        // await this.autoUpdater.checkForUpdates()
        // return
      }
      logger.debug(`检查更新中…… (更新源: ${source})`)

      if (source === 'github') {
        await this.checkUpdateForGithub()
      } else {
        await this.checkUpdateForGhProxy(source)
      }
    } catch (error) {
      const message = `检查更新时发生错误: ${errorMessage(error)}`
      logger.error(message)
      windowManager.send(IPC_CHANNELS.updater.updateError, { message })
    }
  }

  public async downloadUpdate() {
    this.autoUpdater.downloadUpdate()
  }

  public async quitAndInstall() {
    this.autoUpdater.quitAndInstall(false, true)
  }
}

class MacOSUpdater implements Updater {
  private versionInfo: LatestYml | null = null
  private assetsURL: string | null = null
  private savePath: string | null = null
  private safeSource = ''
  /**
   * MacOS 如果使用 autoUpdater 需要提供 zip 文件，但是下载了 zip 之后又不能安装，因为没有签名
   * 所以干脆就手动下载 dmg 文件，下载完毕后退出应用，手动安装
   */
  public async checkForUpdates(source: string) {
    // 先从 latest-mac.yml 中获取目标文件
    try {
      const assetsURL = getAssetsURL()
      this.safeSource = source === 'github' ? '' : new URL(source).href
      this.assetsURL = assetsURL
      const latestYmlURL = `${this.safeSource}${new URL('latest-mac.yml', this.assetsURL)}`
      const ymlContent = (await net.fetch(latestYmlURL).then(res => res.text())) as string
      const latestYml = yaml.parse(ymlContent) as LatestYml

      if (!latestYml) {
        const message = '获取文件更新信息失败'
        throw new Error(message)
      }
      this.versionInfo = latestYml
      if (semver.lte(latestYml.version, app.getVersion())) {
        logger.info(`${app.getVersion()} 已经是最新版本，无需更新`)
        return
      }
    } catch (err) {
      const message = errorMessage(err)
      logger.error(message)
      windowManager.send(IPC_CHANNELS.updater.updateError, { message: message })
      return
    }
    this.downloadUpdate()
  }

  public async downloadUpdate() {
    let fileUrl: string | undefined
    try {
      const setupFile = this.versionInfo?.files.find(file => file.url.endsWith(`${arch()}.dmg`))
      if (!setupFile) {
        const message = '找不到 dmg 文件'
        throw new Error(message)
      }
      // 先检查本地是否已经有了这个文件（计算 Sha512）
      this.savePath = path.join(app.getPath('downloads'), 'oba-update-setup.dmg')
      if (existsSync(this.savePath)) {
        const localFileSha512 = await this.calculateFileHash(this.savePath)
        logger.debug(`检测到本地文件，计算 Sha512 哈希值为 ${localFileSha512}`)
        if (localFileSha512 === setupFile.sha512) {
          logger.debug('本地已存在安装包，无需重复下载')
          windowManager.send(IPC_CHANNELS.updater.updateDownloaded)
          return
        }
      }
      // biome-ignore lint/style/noNonNullAssertion: 确保 assetsURL 不为 null
      fileUrl = `${this.safeSource}${new URL(setupFile.url, this.assetsURL!)}`
      const resp = await net.fetch(fileUrl)
      if (!resp.ok) {
        const message = `网络错误: ${resp.statusText}`
        throw new Error(message)
      }

      const totalBytes = Number.parseInt(resp.headers.get('Content-Length') ?? '0', 10)
      logger.debug(`开始下载文件 ${fileUrl}，文件大小 ${totalBytes / 1024 / 1024} MB`)
      let downloadBytes = 0

      const reader = resp.body?.getReader()
      if (!reader) {
        const message = '获取文件流失败'
        throw new Error(message)
      }
      // 删除已存在的文件
      if (existsSync(this.savePath)) {
        unlinkSync(this.savePath)
      }
      const fileWriter = createWriteStream(this.savePath)

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        downloadBytes += value.length
        fileWriter.write(value)

        if (totalBytes > 0) {
          const progress = (downloadBytes / totalBytes) * 100
          windowManager.send(IPC_CHANNELS.updater.downloadProgress, {
            delta: totalBytes - downloadBytes,
            percent: progress,
            bytesPerSecond: 0,
            transferred: downloadBytes,
            total: totalBytes,
          })
        }
      }
      fileWriter.end()
      logger.debug(`文件 ${fileUrl} 下载完成，保存到 ${this.savePath}`)
      windowManager.send(IPC_CHANNELS.updater.updateDownloaded)
    } catch (err) {
      const message = `下载文件失败: ${errorMessage(err)}`
      logger.error(message)
      windowManager.send(IPC_CHANNELS.updater.updateError, { message, downloadURL: fileUrl })
    }
  }

  public async quitAndInstall() {
    // 找到下载文件的路径
    if (!this.savePath) {
      const message = '未指定下载文件路径'
      throw new Error(message)
    }
    if (existsSync(this.savePath)) {
      // 打开文件
      await shell.openPath(this.savePath)
      // 等待一会后退出应用
      await sleep(3000)
      app.quit()
    } else {
      logger.error(`下载文件 ${this.savePath} 不存在`)
    }
    return
  }

  private calculateFileHash(filePath: string) {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash('sha512')
      const stream = createReadStream(filePath)

      stream.on('data', chunk => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('base64')))
      stream.on('error', reject)
    })
  }
}

export const updateManager = new UpdateManager(
  platform() === 'darwin' ? new MacOSUpdater() : new WindowsUpdater(),
)
