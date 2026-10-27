import { useEffect, useMemo, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Title } from '@/components/common/Title'
import { Card, CardContent } from '@/components/ui/card'
import { useAccounts } from '@/hooks/useAccounts'
import { beijingDay, buildPlacedDayView, type PlacementView } from './placedOrderView'

export default function PlacedOrders() {
  const accountId = useAccounts(state => state.currentAccountId)
  const [day, setDay] = useState(() => beijingDay(new Date().toISOString()))
  const [placement, setPlacement] = useState<PlacementView | null>(null)
  useEffect(() => { void window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.getPlacement, accountId)
    .then(value => setPlacement(value as PlacementView)) }, [accountId])
  const { batches, entries, resolved, unresolved, sizes, groups, count, resolvedCount, parents } = useMemo(
    () => buildPlacedDayView(placement, day), [placement, day])
  return <div className="container py-8 space-y-4 min-h-full">
    <Title title="当日已下单" description="仅统计本机确认的 ERP 人工下单记录；不是抖店实际发货" />
    <Card><CardContent className="pt-6 space-y-4">
      <label className="flex items-center gap-2 text-sm">确认日期（北京时间）<input type="date" value={day}
        onChange={event => setDay(event.target.value)} className="rounded border p-2" /></label>
      {!placement ? <p>正在读取本机记录…</p> : !placement.ok ? <p role="status" className="text-amber-700">{placement.message}</p> : <>
        <p className="font-semibold">{parents} 个主订单、{entries.length} 条确认记录、{count} 件已标记下单</p>
        <p className="text-sm text-muted-foreground">店铺 ID：{placement.ledger?.shop_id}。本页按北京时间的本机确认日期累计各批实际标记下单件数，已扣除每批例外；不会再次扣除历史批次。软件未调用 ERP 下单或抖店发货接口。</p>
        {batches.length > 0 && <div className="rounded border p-3 text-sm"><p className="font-medium">当日 {batches.length} 批</p>
          {batches.map((batch, index) => <p key={batch.id} className="mt-1">第 {index + 1} 批 · {new Date(batch.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · {batch.entries.length} 条子订单 · {batch.entries.reduce((sum, entry) => sum + entry.placed_quantity, 0)} 件</p>)}</div>}
        {entries.length === 0 ? <p>该日没有本机确认记录。</p> : <>
          {unresolved.length > 0 && <p role="status" className="text-amber-700">{unresolved.length} 条确认记录、{count - resolvedCount} 件缺少对应历史快照规格，未猜填到尺码矩阵；请在下方明细核对。</p>}
          {resolved.length > 0 && <div className="max-h-[70vh] overflow-auto rounded border"><table className="w-full border-collapse text-sm">
            <thead><tr><th className="sticky top-0 z-10 bg-slate-50 p-3 text-left shadow-sm">商家编码或商品名称 · 颜色/款式/原规格</th>
              {sizes.map(size => <th key={size} className="sticky top-0 z-10 bg-slate-50 p-3 text-center shadow-sm">{size}</th>)}
              <th className="sticky top-0 z-10 bg-slate-50 p-3 text-center shadow-sm">已下单件数</th>
              <th className="sticky top-0 z-10 bg-slate-50 p-3 text-center shadow-sm">确认记录</th></tr></thead>
            <tbody>{groups.map(group => <tr key={group.key} className="border-t">
              <td className="p-3"><div className="font-medium">{group.row.merchant_code || group.row.product_name} · {group.row.variant_role === 'raw_spec' ? '原规格：' : ''}{group.row.color}</div>
                <div className="text-xs text-muted-foreground">{group.row.merchant_code ? '商家编码' : '商家编码未填写；按商品名称展示'}｜商品 ID：{group.row.product_id}</div></td>
              {sizes.map(size => <td key={size} className="p-3 text-center">{group.sizes[size] || '—'}</td>)}
              <td className="p-3 text-center">{group.quantity}</td><td className="p-3 text-center">{group.children}</td>
            </tr>)}</tbody>
          </table></div>}
          <details className="text-sm"><summary className="cursor-pointer">查看当日确认记录明细</summary>
            <div className="mt-2 max-h-72 overflow-auto rounded border"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-2">主订单号</th><th className="p-2">子订单号</th><th className="p-2">已下单件数</th><th className="p-2">确认时间</th></tr></thead>
              <tbody>{entries.map(entry => <tr key={`${entry.batchId}:${entry.sku_order_id}`} className="border-b"><td className="p-2">{entry.shop_order_id}</td><td className="p-2">{entry.sku_order_id}</td><td className="p-2">{entry.placed_quantity}</td><td className="p-2">{new Date(entry.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</td></tr>)}</tbody></table></div>
          </details>
          <p className="text-xs text-muted-foreground">撤销最近一次本机确认仍在“自动整理订单”页；撤销只改本机标记。</p>
        </>}
      </>}
    </CardContent></Card>
  </div>
}
