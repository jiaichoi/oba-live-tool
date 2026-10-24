import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { useAccounts } from '@/hooks/useAccounts'
import { useCurrentChromeConfig } from '@/hooks/useChromeConfig'

type ShopStatus = {
  accountId: string
  phase: 'disconnected' | 'opening' | 'browser-open' | 'login-required' | 'logged-in-unverified' | 'failed'
  message: string
  updatedAt: string
}
type DownloadResult = {
  accountId: string
  ok: boolean
  filename: string
  savedAt: string
  localPath: string
  message: string
}

export default function OrderExport({ title = '订单报表下载' }: { title?: string }) {
  const accountId = useAccounts(state => state.currentAccountId)
  const accountName = useAccounts(state => state.accounts.find(account => account.id === state.currentAccountId)?.name ?? '默认账号')
  const chromePath = useCurrentChromeConfig(config => config.path)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ShopStatus | null>(null)
  const [downloads, setDownloads] = useState<DownloadResult[]>([])

  useEffect(() => {
    let active = true
    setDownloads([])
    void window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.getStatus, accountId).then(result => {
      if (active) setStatus(result)
    })
    const removeStatus = window.ipcRenderer.on(IPC_CHANNELS.orderExport.status, result => {
      if (result.accountId === accountId) setStatus(result)
    })
    const removeDownload = window.ipcRenderer.on(IPC_CHANNELS.orderExport.downloaded, result => {
      if (result.accountId === accountId) setDownloads(previous => [result, ...previous])
    })
    return () => { active = false; removeStatus(); removeDownload() }
  }, [accountId])

  const run = async (action: () => Promise<ShopStatus>) => {
    setBusy(true)
    try { setStatus(await action()) }
    catch { setStatus({ accountId, phase: 'failed', message: '连接请求失败；未执行订单操作。', updatedAt: new Date().toISOString() }) }
    finally { setBusy(false) }
  }

  const connect = () => run(() => window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.open, accountId, chromePath))
  const check = () => run(() => window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.check, accountId))
  const disconnect = () => run(() => window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.close, accountId))
  const reconnect = () => run(async () => {
    await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.close, accountId)
    return window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.open, accountId, chromePath)
  })

  return <div className="container py-8 space-y-6">
    <div>
      <h2 className="text-2xl font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground mt-2">
        当前 OBA 账号：{accountName}。点击连接后会打开独立的抖店店铺浏览器；请在官方页面自行登录。
        连接店铺后台不启动直播、自动发言或发货操作。
      </p>
    </div>
    <section className="rounded-lg border bg-white p-5 space-y-4">
      <p role="status" className="font-medium">{status?.message ?? '正在读取连接状态…'}</p>
      <p className="text-sm text-muted-foreground">
        {status?.phase === 'logged-in-unverified'
          ? '已检测到登录；订单权限、店铺 ID 和待发货数据仍未核验。'
          : '浏览器已打开不代表已登录；登录成功也不代表订单已同步。'}
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy} onClick={connect}
          className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
          {busy ? '连接中…' : '连接店铺后台'}
        </button>
        <button type="button" disabled={busy} onClick={check} className="rounded border px-4 py-2 disabled:opacity-50">刷新登录状态</button>
        <button type="button" disabled={busy} onClick={reconnect} className="rounded border px-4 py-2 disabled:opacity-50">重新连接</button>
        <button type="button" disabled={busy} onClick={disconnect} className="rounded border px-4 py-2 disabled:opacity-50">断开店铺后台</button>
      </div>
      <p className="text-xs text-muted-foreground">当前订单读取仍待核验；下载候选文件不会自动覆盖待发货矩阵。</p>
    </section>
    <section className="rounded-lg border bg-white p-5">
      <h3 className="font-semibold mb-3">当前账号本次下载</h3>
      {downloads.length === 0 ? <p className="text-sm text-muted-foreground">尚无下载结果。</p> :
        <ul className="space-y-4">{downloads.map((item, index) =>
          <li key={`${item.savedAt}-${index}`} className="border-b pb-3 text-sm">
            <p>{item.message}</p><p>文件：{item.filename}</p>
            {item.ok && <p>下载完成时间：{item.savedAt}；本机位置：{item.localPath}</p>}
          </li>)}</ul>}
    </section>
  </div>
}
