import { CheckIcon, GlobeIcon, RotateCwIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Title } from '@/components/common/Title'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
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
type OrderPageProbe = {
  ok: boolean
  message: string
  observedAt: string
  sourceUrl: string | null
  hasRecentPartition: boolean
  hasOlderPartition: boolean
  hasPendingFilter: boolean
  visiblePendingMainOrderCount: number | null
  domHints?: string[]
}

const stateLabels: Record<ShopStatus['phase'], string> = {
  disconnected: '未连接',
  opening: '连接中',
  'browser-open': '店铺会话待登录',
  'login-required': '待登录',
  'logged-in-unverified': '已登录，订单待核验',
  failed: '连接失败',
}

export default function OrderExport({ title = '订单报表下载' }: { title?: string }) {
  const accountId = useAccounts(state => state.currentAccountId)
  const accountName = useAccounts(state => state.accounts.find(account => account.id === state.currentAccountId)?.name ?? '默认账号')
  const chromePath = useCurrentChromeConfig(config => config.path)
  const [busy, setBusy] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [status, setStatus] = useState<ShopStatus | null>(null)
  const [downloads, setDownloads] = useState<DownloadResult[]>([])
  const [orderProbe, setOrderProbe] = useState<OrderPageProbe | null>(null)
  const [capture, setCapture] = useState<{ ok: boolean; message: string; localPath?: string; parents?: number;
    lines?: number; pages?: number[]; issues?: string[] } | null>(null)

  useEffect(() => {
    let active = true
    setStatus(null)
    setDownloads([])
    setOrderProbe(null)
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
  const probeOrderPage = async () => {
    setBusy(true)
    try { setOrderProbe(await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.probeOrderPage, accountId)) }
    catch { setOrderProbe({ ok: false, message: '订单页只读检查失败；未同步。', observedAt: new Date().toISOString(),
      sourceUrl: null, hasRecentPartition: false, hasOlderPartition: false, hasPendingFilter: false,
      visiblePendingMainOrderCount: null }) }
    finally { setBusy(false) }
  }
  const capturePendingRows = async () => {
    setBusy(true)
    try { setCapture(await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.capturePendingRows, accountId)) }
    catch { setCapture({ ok: false, message: '订单行只读采集失败；旧快照未改动。' }) }
    finally { setBusy(false) }
  }
  const isConnected = status?.phase === 'logged-in-unverified'
  const isOpening = busy || status?.phase === 'opening'
  const isWaiting = status?.phase === 'browser-open' || status?.phase === 'login-required'
  const isShopPage = title === '连接店铺后台'

  return <div className="container py-8 space-y-4">
    <Title title={title} description={isShopPage ? '连接并管理您的店铺后台' : '在店铺后台下载订单报表'} />
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>店铺后台状态</CardTitle>
          <CardDescription>查看并管理当前 OBA 账号的店铺后台连接状态</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4" role="status">
              <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500' : isWaiting || isOpening ? 'bg-amber-500' : 'bg-gray-300'}`} />
              <span className="text-sm text-muted-foreground">{status ? stateLabels[status.phase] : '正在读取状态…'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-md border px-3 py-1.5 text-sm" aria-label="当前平台">抖音小店</span>
              {isConnected ? <>
                <Button variant="outline" size="sm" disabled={busy} onClick={connect}>
                  <GlobeIcon className="mr-2 h-4 w-4" />打开店铺后台
                </Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={disconnect}
                  onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
                  {hovered ? <><XIcon className="mr-2 h-4 w-4" />断开连接</> : <><CheckIcon className="mr-2 h-4 w-4" />已连接</>}
                </Button>
              </> : <Button size="sm" disabled={isOpening} onClick={connect}>
                <GlobeIcon className="mr-2 h-4 w-4" />{isOpening ? '连接中...' : isWaiting ? '打开店铺后台' : '连接店铺后台'}
              </Button>}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{status?.message ?? '正在读取连接状态…'}</p>
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm">当前账号：{accountName}</div>
              <div className="text-xs text-muted-foreground">店铺后台与直播中控台独立连接，切换账号后显示对应状态。</div>
            </div>
            <Button variant="outline" size="sm" disabled={busy} onClick={check}>
              <RotateCwIcon className="mr-2 h-4 w-4" />刷新状态
            </Button>
          </div>
          <Separator />
          <div>
            <div className="text-sm">订单同步</div>
            <div className="text-xs text-muted-foreground">店铺 ID 与自动同步权限仍待核验；“全部待发货”显示本机最近一次页面读取快照。</div>
            <Button variant="outline" size="sm" className="mt-3" disabled={busy || !isConnected} onClick={probeOrderPage}>
              只读检查已打开的订单页
            </Button>
            <Button variant="outline" size="sm" className="mt-3 ml-2" disabled={busy || !isConnected} onClick={capturePendingRows}>
              逐页读取待发货候选明细
            </Button>
            {capture && <div className="mt-2 space-y-1 text-xs text-muted-foreground" role="status">
              <p>{capture.message}</p>
              {capture.ok && <><p>主订单行 {capture.parents}；商品行 {capture.lines}；两个时间分区分页 {capture.pages?.join(' / ')}。</p>
                <p>本机候选文件：{capture.localPath}</p>
                <p>待核事项：{capture.issues?.join('；') || '仍须核实店铺 ID、绝对承诺发货时间与读取期间变化'}</p></>}
            </div>}
            {orderProbe && <div className="mt-2 space-y-1 text-xs text-muted-foreground" role="status">
              <p>{orderProbe.message}</p>
              <p>近 6 个月分区：{orderProbe.hasRecentPartition ? '已见' : '未见'}；6 个月前分区：{orderProbe.hasOlderPartition ? '已见' : '未见'}；待发货筛选：{orderProbe.hasPendingFilter ? '出现文字，筛选值待核验' : '未见'}。</p>
              {orderProbe.visiblePendingMainOrderCount !== null && <p>页面文字中出现待发货 {orderProbe.visiblePendingMainOrderCount}；未确认其分区、单位或完整性。</p>}
              {orderProbe.domHints && <details><summary>只读页面结构线索</summary><pre className="whitespace-pre-wrap break-all">{orderProbe.domHints.join('\n')}</pre></details>}
            </div>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>使用说明</CardTitle>
          <CardDescription>订单履约的当前功能</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            '选择顶部 OBA 账号，点击“连接店铺后台”；登录后会自动打开订单列表的待发货页。',
            '“全部待发货”显示最近一次已核对的本机页面快照；还不是实时自动同步。',
            '“当日已发货”按已导入报表的实际发货时间统计；“全部订单”查看已导入的订单明细。',
            '如需更新订单，可在“订单报表下载”获取候选报表，并核验范围后通过“数据管理 → 导入报表”导入。',
          ].map((step, index) => <div className="flex gap-3" key={step}>
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">{index + 1}</div>
            <p className="text-sm leading-6 text-muted-foreground">{step}</p>
          </div>)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>当前账号本次下载</CardTitle>
          <CardDescription>候选报表不会自动覆盖待发货矩阵</CardDescription>
        </CardHeader>
        <CardContent>
          {downloads.length === 0 ? <p className="text-sm text-muted-foreground">尚无下载结果。</p> :
            <ul className="space-y-4">{downloads.map((item, index) =>
              <li key={`${item.savedAt}-${index}`} className="border-b pb-3 text-sm">
                <p>{item.message}</p><p>文件：{item.filename}</p>
                {item.ok && <p>下载完成时间：{item.savedAt}；本机位置：{item.localPath}</p>}
              </li>)}</ul>}
        </CardContent>
      </Card>
    </div>
  </div>
}
