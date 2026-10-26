import { useEffect, useMemo, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Title } from '@/components/common/Title'
import { Card, CardContent } from '@/components/ui/card'
import { useAccounts } from '@/hooks/useAccounts'

type Entry = { shop_order_id: string; sku_order_id: string; placed_quantity: number; source_quantity: number }
type Batch = { id: string; at: string; undone_at?: string; entries: Entry[] }
type Placement = { ok: boolean; message?: string; ledger?: { shop_id: string; batches: Batch[] } }

const beijingDay = (iso: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric',
    month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso))
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export default function PlacedOrders() {
  const accountId = useAccounts(state => state.currentAccountId)
  const [day, setDay] = useState(() => beijingDay(new Date().toISOString()))
  const [placement, setPlacement] = useState<Placement | null>(null)
  useEffect(() => { void window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.getPlacement, accountId)
    .then(value => setPlacement(value as Placement)) }, [accountId])
  const batches = useMemo(() => (placement?.ledger?.batches ?? [])
    .filter(batch => !batch.undone_at && beijingDay(batch.at) === day), [placement, day])
  const entries = batches.flatMap(batch => batch.entries.map(entry => ({ ...entry, batchId: batch.id, at: batch.at })))
  const count = entries.reduce((sum, entry) => sum + entry.placed_quantity, 0)
  const parents = new Set(entries.map(entry => entry.shop_order_id)).size
  return <div className="container py-8 space-y-4 min-h-full">
    <Title title="当日已下单" description="仅统计本机确认的 ERP 人工下单记录；不是抖店实际发货" />
    <Card><CardContent className="pt-6 space-y-4">
      <label className="flex items-center gap-2 text-sm">确认日期（北京时间）<input type="date" value={day}
        onChange={event => setDay(event.target.value)} className="rounded border p-2" /></label>
      {!placement ? <p>正在读取本机记录…</p> : !placement.ok ? <p role="status" className="text-amber-700">{placement.message}</p> : <>
        <p className="font-semibold">{parents} 个主订单、{entries.length} 条确认记录、{count} 件已标记下单</p>
        <p className="text-sm text-muted-foreground">店铺 ID：{placement.ledger?.shop_id}。跨日已下单记录继续保留；本页仅按确认日期筛选。确认发生在 ERP 人工下单之后，软件未调用 ERP 下单或抖店发货接口。</p>
        {batches.length > 0 && <div className="rounded border p-3 text-sm"><p className="font-medium">当日 {batches.length} 批</p>
          {batches.map((batch, index) => <p key={batch.id} className="mt-1">第 {index + 1} 批 · {new Date(batch.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · {batch.entries.length} 条子订单 · {batch.entries.reduce((sum, entry) => sum + entry.placed_quantity, 0)} 件</p>)}</div>}
        {entries.length === 0 ? <p>该日没有本机确认记录。</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-2">主订单号</th><th className="p-2">子订单号</th><th className="p-2">已下单件数</th><th className="p-2">确认时间</th></tr></thead>
          <tbody>{entries.map(entry => <tr key={`${entry.batchId}:${entry.sku_order_id}`} className="border-b"><td className="p-2">{entry.shop_order_id}</td><td className="p-2">{entry.sku_order_id}</td><td className="p-2">{entry.placed_quantity}</td><td className="p-2">{new Date(entry.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</td></tr>)}</tbody></table></div>}
      </>}
    </CardContent></Card>
  </div>
}
