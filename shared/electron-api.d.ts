import type { LogMessage } from 'electron-log'
import type { ProgressInfo, UpdateDownloadedEvent } from 'electron-updater'
import { IPC_CHANNELS } from './ipcChannels'

export interface IpcChannels {
  // LiveControl
  [IPC_CHANNELS.tasks.liveControl.connect]: (params: {
    chromePath?: string
    headless?: boolean
    storageState?: string
    platform: LiveControlPlatform
    account: Account
  }) => boolean
  [IPC_CHANNELS.tasks.liveControl.disconnect]: (accountId: string) => boolean
  [IPC_CHANNELS.tasks.liveControl.disconnectedEvent]: (id: string) => void
  [IPC_CHANNELS.tasks.liveControl.notifyAccountName]: (
    params:
      | {
          ok: true
          accountId: string
          accountName: string | null
        }
      | { ok: false },
  ) => void

  // AutoMessage
  [IPC_CHANNELS.tasks.autoMessage.start]: (accountId: string, config: AutoCommentConfig) => boolean
  [IPC_CHANNELS.tasks.autoMessage.stop]: (accountId: string) => boolean
  [IPC_CHANNELS.tasks.autoMessage.stoppedEvent]: (id: string) => void
  [IPC_CHANNELS.tasks.autoMessage.sendBatchMessages]: (
    accountId: string,
    messages: string[],
    count: number,
  ) => boolean
  [IPC_CHANNELS.tasks.autoMessage.updateConfig]: (
    accountId: string,
    config: Parital<AutoCommentConfig>,
  ) => void

  // AutoPopup
  [IPC_CHANNELS.tasks.autoPopUp.start]: (accountId: string, config: AutoPopupConfig) => boolean
  [IPC_CHANNELS.tasks.autoPopUp.stop]: (accountId: string) => boolean
  [IPC_CHANNELS.tasks.autoPopUp.stoppedEvent]: (id: string) => void
  [IPC_CHANNELS.tasks.autoPopUp.updateConfig]: (
    accountId: string,
    config: Parital<AutoPopupConfig>,
  ) => void
  [IPC_CHANNELS.tasks.autoPopUp.registerShortcuts]: (
    accountId: string,
    shortcuts: { accelerator: string; goodsIds: number[] }[],
  ) => void
  [IPC_CHANNELS.tasks.autoPopUp.unregisterShortcuts]: () => void

  // AutoReply
  [IPC_CHANNELS.tasks.autoReply.startCommentListener]: (
    accountId: string,
    config: CommentListenerConfig,
  ) => boolean
  [IPC_CHANNELS.tasks.autoReply.stopCommentListener]: (accountId: string) => void
  [IPC_CHANNELS.tasks.autoReply.sendReply]: (accountId: string, replyContent: string) => void
  [IPC_CHANNELS.tasks.autoReply.listenerStopped]: (accountId: string) => void
  [IPC_CHANNELS.tasks.autoReply.showComment]: (data: {
    comment: LiveMessage
    accountId: string
  }) => void

  // AIChat
  [IPC_CHANNELS.tasks.aiChat.normalChat]: (params: {
    messages: AIChatMessage[]
    provider: string
    model: string
    apiKey: string
    customBaseURL?: string
  }) => string | null
  [IPC_CHANNELS.tasks.aiChat.testApiKey]: (params: {
    apiKey: string
    provider: string
    customBaseURL?: string
  }) => { success: boolean; models?: string[]; error?: string }
  [IPC_CHANNELS.tasks.aiChat.chat]: (params: {
    messages: AIChatMessage[]
    provider: string
    model: string
    apiKey: string
    customBaseURL?: string
  }) => void
  [IPC_CHANNELS.tasks.aiChat.stream]: (
    data:
      | {
          chunk: string
          type: 'content' | 'reasoning'
        }
      | { done: boolean },
  ) => void
  [IPC_CHANNELS.tasks.aiChat.error]: (data: { error: string }) => void

  // 视频号上墙
  [IPC_CHANNELS.tasks.pinComment]: (params: { accountId: string; content: string }) => void

  // 一键发红包
  [IPC_CHANNELS.tasks.redPacket.send]: (accountId: string, duration: string) => boolean

  // Updater
  [IPC_CHANNELS.updater.checkUpdate]: () => Promise<
    { latestVersion: string; currentVersion: string; releaseNote?: string } | undefined
  >
  [IPC_CHANNELS.updater.startDownload]: (source: string) => void
  [IPC_CHANNELS.updater.quitAndInstall]: () => void
  [IPC_CHANNELS.updater.updateAvailable]: (info: VersionInfo) => void
  [IPC_CHANNELS.updater.updateError]: (error: ErrorType) => void
  [IPC_CHANNELS.updater.downloadProgress]: (progress: ProgressInfo) => void
  [IPC_CHANNELS.updater.updateDownloaded]: (event?: UpdateDownloadedEvent) => void

  // Chrome
  [IPC_CHANNELS.chrome.selectPath]: () => string | null
  [IPC_CHANNELS.chrome.getPath]: (edge?: boolean) => string | null
  [IPC_CHANNELS.chrome.toggleDevTools]: () => void
  [IPC_CHANNELS.chrome.setPath]: (path: string) => void
  [IPC_CHANNELS.chrome.saveState]: (accountId: string, state: string) => void

  // App
  [IPC_CHANNELS.app.openLogFolder]: () => void
  [IPC_CHANNELS.app.openExternal]: (url: string) => void
  [IPC_CHANNELS.app.notifyUpdate]: (arg: {
    currentVersion: string
    latestVersion: string
    releaseNote?: string
  }) => void
  [IPC_CHANNELS.app.getProviders]: () => Record<string, ProviderInfo>
  [IPC_CHANNELS.app.providersUpdated]: (providers: Record<string, ProviderInfo>) => void

  [IPC_CHANNELS.account.switch]: (params: { account: Account }) => void

  [IPC_CHANNELS.workbench.show]: (bounds: {
    x: number
    y: number
    width: number
    height: number
    viewportWidth: number
    path: string
    requestKey: string
    preservePath?: string
  }) => void
  [IPC_CHANNELS.workbench.hide]: (requestKey: string) => void
  [IPC_CHANNELS.workbench.reloadDue]: () => Promise<boolean>
  [IPC_CHANNELS.workbench.navigated]: (location: { path: string }) => void
  [IPC_CHANNELS.orderExport.open]: (accountId: string, chromePath?: string) => Promise<{
    accountId: string
    phase: 'disconnected' | 'opening' | 'browser-open' | 'login-required' | 'logged-in-unverified' | 'failed'
    message: string
    updatedAt: string
  }>
  [IPC_CHANNELS.orderExport.close]: (accountId: string) => Promise<{
    accountId: string
    phase: 'disconnected' | 'opening' | 'browser-open' | 'login-required' | 'logged-in-unverified' | 'failed'
    message: string
    updatedAt: string
  }>
  [IPC_CHANNELS.orderExport.check]: (accountId: string) => Promise<{
    accountId: string
    phase: 'disconnected' | 'opening' | 'browser-open' | 'login-required' | 'logged-in-unverified' | 'failed'
    message: string
    updatedAt: string
  }>
  [IPC_CHANNELS.orderExport.probeOrderPage]: (accountId: string) => Promise<{
    ok: boolean
    message: string
    observedAt: string
    sourceUrl: string | null
    hasRecentPartition: boolean
    hasOlderPartition: boolean
    hasPendingFilter: boolean
    visiblePendingMainOrderCount: number | null
    domHints?: string[]
  }>
  [IPC_CHANNELS.orderExport.capturePendingRows]: (accountId: string) => Promise<{
    ok: boolean
    message: string
    localPath?: string
    parents?: number
    lines?: number
    pages?: number[]
    issues?: string[]
  }>
  [IPC_CHANNELS.orderExport.organizePending]: (accountId: string) => Promise<{
    ok: boolean
    message: string
    parents?: number
    children?: number
    quantity?: number
    empty?: boolean
    observedAt?: string
  }>
  [IPC_CHANNELS.orderExport.getPendingView]: () => Promise<{
    available: boolean
    scope?: string
    observed_at?: string
    page_complete?: boolean
    displayed_parent_count?: number
    rows?: Array<{ shop_order_id: string; sku_order_id: string; merchant_code: string;
      product_id: string; product_name: string; color: string; size: string; quantity: number;
      variant_role?: 'color' | 'raw_spec'; variant_review_reason?: string }>
  }>
  [IPC_CHANNELS.orderExport.getStatus]: (accountId: string) => Promise<{
    accountId: string
    phase: 'disconnected' | 'opening' | 'browser-open' | 'login-required' | 'logged-in-unverified' | 'failed'
    message: string
    updatedAt: string
  }>
  [IPC_CHANNELS.orderExport.status]: (status: {
    accountId: string
    phase: 'disconnected' | 'opening' | 'browser-open' | 'login-required' | 'logged-in-unverified' | 'failed'
    message: string
    updatedAt: string
  }) => void
  [IPC_CHANNELS.orderExport.downloaded]: (result: {
    accountId: string
    ok: boolean
    filename: string
    savedAt: string
    localPath: string
    message: string
  }) => void
  [IPC_CHANNELS.orderSync.getStatus]: (accountId: string) => Promise<{
    accountId: string
    phase: 'idle' | 'verifying' | 'awaiting-verification' | 'failed' | 'current'
    message: string
    shopId: string | null
    lastSuccessAt: string | null
    updatedAt: string
  } | null>
  [IPC_CHANNELS.orderSync.status]: (status: {
    accountId: string
    phase: 'idle' | 'verifying' | 'awaiting-verification' | 'failed' | 'current'
    message: string
    shopId: string | null
    lastSuccessAt: string | null
    updatedAt: string
  }) => void

  // Log
  [IPC_CHANNELS.log]: (message: LogMessage) => void
}

export interface ElectronAPI {
  ipcRenderer: {
    invoke: <Channel extends keyof IpcChannels>(
      channel: Channel,
      ...args: Parameters<IpcChannels[Channel]>
    ) => ReturnType<IpcChannels[Channel]> extends Promise<infer _U>
      ? ReturnType<IpcChannels[Channel]>
      : Promise<ReturnType<IpcChannels[Channel]>>

    send: <Channel extends keyof IpcChannels>(
      channel: Channel,
      ...args: Parameters<IpcChannels[Channel]>
    ) => void

    on: <Channel extends keyof IpcChannels>(
      channel: Channel,
      listener: (...args: Parameters<IpcChannels[Channel]>) => void,
    ) => () => void
  }
}
