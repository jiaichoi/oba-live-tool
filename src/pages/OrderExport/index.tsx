import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'

type DownloadResult = {
  ok: boolean
  filename: string
  savedAt: string
  localPath: string
  message: string
}

export default function OrderExport() {
  const [opening, setOpening] = useState(false)
  const [status, setStatus] = useState('尚未打开抖店订单后台。')
  const [downloads, setDownloads] = useState<DownloadResult[]>([])

  useEffect(() => window.ipcRenderer.on(IPC_CHANNELS.orderExport.downloaded, result => {
    setDownloads(previous => [result, ...previous])
  }), [])

  const open = async () => {
    setOpening(true)
    try {
      const result = await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.open)
      setStatus(result.message)
    } finally {
      setOpening(false)
    }
  }

  const close = async () => {
    await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.close)
    setStatus('订单后台浏览器已关闭。')
  }

  return (
    <div className="container py-8 space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">订单报表下载</h2>
        <p className="text-sm text-muted-foreground mt-2">
          打开抖店官方页面后，由你自行登录并操作订单筛选、导出和短信验证。
          本功能监听 ZIP/CSV 下载并保存候选文件；当前尚未自动查询或发起导出。
        </p>
      </div>
      <section className="rounded-lg border bg-white p-5 space-y-3">
        <p>{status}</p>
        <div className="flex gap-3">
          <button type="button" disabled={opening} onClick={open}
            className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
            {opening ? '正在打开…' : '打开抖店订单后台'}
          </button>
          <button type="button" onClick={close} className="rounded border px-4 py-2">关闭订单浏览器</button>
        </div>
        <p className="text-xs text-muted-foreground">
          下载候选文件不等于有效订单报表；导入前必须核对店铺、筛选范围、报表 ID、生成时间、原始行数与拒绝数。
        </p>
      </section>
      <section className="rounded-lg border bg-white p-5">
        <h3 className="font-semibold mb-3">本次下载</h3>
        {downloads.length === 0 ? <p className="text-sm text-muted-foreground">尚无下载结果。</p> : (
          <ul className="space-y-4">
            {downloads.map((item, index) => (
              <li key={`${item.savedAt}-${index}`} className="border-b pb-3 text-sm">
                <p>{item.message}</p>
                <p>文件：{item.filename}</p>
                {item.ok && <p>下载完成时间：{item.savedAt}；本机位置：{item.localPath}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
