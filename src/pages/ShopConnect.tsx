import { useEffect, useState } from 'react'
import { GlobeIcon } from 'lucide-react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Title } from '@/components/common/Title'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAccounts } from '@/hooks/useAccounts'
import { useCurrentChromeConfig } from '@/hooks/useChromeConfig'

type Status = { accountId: string; phase: string; message: string }
const otherPlatforms = ['巨量百应', '抖音团购', '小红书千帆', '小红书蒲公英', '视频号', '快手小店', '淘宝']

export default function ShopConnect() {
  const accountId = useAccounts(state => state.currentAccountId)
  const chromePath = useCurrentChromeConfig(config => config.path)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const connected = status?.phase === 'logged-in-unverified'
  const statusLabel = connected
    ? (status?.message.includes('已打开订单列表的待发货页') ? '已进入待发货页' : '已登录，正在进入订单页')
    : status?.phase === 'login-required' ? '待登录'
    : status?.phase === 'browser-open' || status?.phase === 'opening' ? '窗口已打开，待核验登录'
    : status?.phase === 'failed' ? '连接异常' : '未连接'
  useEffect(() => {
    let active = true
    void window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.getStatus, accountId).then(value => {
      if (active) setStatus(value)
    })
    const remove = window.ipcRenderer.on(IPC_CHANNELS.orderExport.status, value => {
      if (value.accountId === accountId) setStatus(value)
    })
    return () => { active = false; remove() }
  }, [accountId])
  const open = async () => {
    setBusy(true)
    try { setStatus(await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.open, accountId, chromePath)) }
    catch { setStatus({ accountId, phase: 'failed', message: '店铺窗口打开失败，请重试。' }) }
    finally { setBusy(false) }
  }
  const disconnect = async () => {
    setBusy(true)
    try { setStatus(await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.close, accountId)) }
    finally { setBusy(false) }
  }
  return <div className="container py-8 space-y-4">
    <Title title="打开店铺订单" description="连接并管理店铺订单页面" />
    <Card><CardHeader><CardTitle>订单页面状态</CardTitle></CardHeader><CardContent className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3" role="status">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : status?.phase === 'failed' ? 'bg-red-500' : 'bg-gray-300'}`} />
          <span>{statusLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          <Select value="douyin" disabled={busy}>
            <SelectTrigger className="w-[180px]" aria-label="订单平台"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="douyin">抖音小店</SelectItem>
              {otherPlatforms.map(name => <SelectItem key={name} value={name} disabled>{name} · 订单未接入</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={open} disabled={busy}><GlobeIcon className="mr-2 h-4 w-4" />{busy ? '打开中…' : '打开店铺订单'}</Button>
          {connected && <Button size="sm" variant="secondary" onClick={disconnect} disabled={busy}>断开连接</Button>}
        </div>
      </div>
      <p className="text-muted-foreground">{status?.message ?? '正在读取连接状态…'}</p>
      <Separator />
      <p className="text-muted-foreground">当前仅支持抖音小店订单页面；直播中控台支持的其他平台尚未接入订单整理。关闭窗口后可再次点击“打开店铺订单”。</p>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>使用说明</CardTitle></CardHeader><CardContent className="space-y-3 text-sm text-muted-foreground">
      {['选择订单平台（当前为抖音小店）', '打开店铺订单，在官方页面自行登录', '进入“自动整理订单”，点击“开始整理”读取当前待发货'].map((step, index) =>
        <div key={step} className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 font-medium text-primary">{index + 1}</span><span>{step}</span></div>)}
    </CardContent></Card>
  </div>
}
