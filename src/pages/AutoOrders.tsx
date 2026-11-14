import { useCallback, useEffect, useMemo, useState } from 'react'
import { PlayIcon } from 'lucide-react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog'
import { Title } from '@/components/common/Title'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAccounts } from '@/hooks/useAccounts'
import { compareSizes, groupMatrixRows } from './orderMatrix'
import { filterRowsByFulfillment, orderScopeKey, useOrderFulfillmentStore } from './orderFulfillmentStore'

type Status = { accountId: string; phase: string; message: string }
type Result = { ok: boolean; message: string }
type DueRow = { shop_order_id: string; sku_order_id: string; merchant_code: string; product_id: string;
  product_name: string; color: string; size: string; quantity: number; promised_ship_day: string;
  variant_role?: 'color' | 'raw_spec'; variant_review_reason?: string }
type DueView = { available: boolean; scope?: string; observed_at?: string; day?: string;
  page_complete?: boolean; displayed_parent_count?: number; source_pending_count?: number;
  shop_id_verified?: string; rows?: DueRow[] }
type Mode = 'today' | 'all' | 'to-order' | 'manual-shipped'
type OrderGroup = { id: string; rows: DueRow[]; quantity: number }

function currentBeijingDay(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function groupOrders(rows: DueRow[]): OrderGroup[] {
  const groups = new Map<string, OrderGroup>()
  for (const row of rows) {
    const id = row.shop_order_id || `missing:${row.sku_order_id}`
    const group = groups.get(id) ?? { id, rows: [], quantity: 0 }
    group.rows.push(row)
    group.quantity += Number(row.quantity)
    groups.set(id, group)
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id, 'zh-CN'))
}

export default function AutoOrders({ mode = 'today' }: { mode?: Mode }) {
  const accountId = useAccounts(state => state.currentAccountId)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [view, setView] = useState<DueView | null>(null)
  const [viewError, setViewError] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [today, setToday] = useState(currentBeijingDay)
  const marks = useOrderFulfillmentStore(state => state.marks)
  const batches = useOrderFulfillmentStore(state => state.batches)
  const createPrintBatch = useOrderFulfillmentStore(state => state.createPrintBatch)
  const completeBatch = useOrderFulfillmentStore(state => state.completeBatch)
  const restoreBatch = useOrderFulfillmentStore(state => state.restoreBatch)
  const [printPreview,setPrintPreview] = useState<{accountId:string;shopId:string;day:string;observedAt:string;rows:DueRow[]} | null>(null)
  const clearOtherDays = useOrderFulfillmentStore(state => state.clearOtherDays)
  const connected = status?.phase === 'logged-in-unverified'
  useEffect(() => { clearOtherDays(today) }, [clearOtherDays, today])
  const refreshView = useCallback(async () => {
    try {
      setView(await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.getPendingView, accountId) as DueView)
      setViewError(false)
    } catch { setViewError(true) }
  }, [accountId])
  useEffect(() => {
    let active = true
    setResult(null)
    void window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.getStatus, accountId).then(value => {
      if (active) setStatus(value)
    })
    const remove = window.ipcRenderer.on(IPC_CHANNELS.orderExport.status, value => {
      if (value.accountId === accountId) setStatus(value)
    })
    void refreshView()
    const timer = setInterval(() => { setToday(currentBeijingDay()); void refreshView() }, 60_000)
    return () => { active = false; remove(); clearInterval(timer) }
  }, [accountId, refreshView])
  const run = async (kind: 'organize' | 'probe' | 'capture') => {
    setBusy(true)
    setResult(null)
    try {
      let value: Result
      if (kind === 'organize') value = await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.organizePending, accountId)
      else if (kind === 'capture') value = await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.capturePendingRows, accountId)
      else {
        const probe = await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.probeOrderPage, accountId)
        value = { ok: probe.ok, message: `${probe.message} 页面文字显示待发货 ${probe.visiblePendingMainOrderCount ?? '待核'}。此项不更新矩阵。` }
      }
      setResult(value)
      if (kind === 'organize' && value.ok) await refreshView()
    } catch { setResult({ ok: false, message: '订单页面读取失败；未保存订单。' }) }
    finally { setBusy(false) }
  }
  const allRows = view?.available && view.scope === 'pending_and_today_due' && view.day === today && Array.isArray(view.rows) ? view.rows : []
  const scope = { accountId: String(accountId ?? ''), day: today }
  const statusFor = (orderId: string) => marks[orderScopeKey({ ...scope, shopOrderId: orderId })]
  const sourceMode = mode === 'today' || mode === 'all'
  const sourceRows = mode === 'today' ? allRows.filter(row => row.promised_ship_day === today) : allRows
  const relevantBatches = batches.filter(batch=>batch.accountId===accountId && batch.day===today)
  const displayBatches = relevantBatches.filter(batch=>mode==='to-order' ? !batch.orderedAt : Boolean(batch.orderedAt))
  const rows = sourceMode ? filterRowsByFulfillment(sourceRows,'pending',statusFor) : displayBatches.flatMap(batch=>batch.rows)
  const sizes = useMemo(() => [...new Set(rows.map(row => row.size).filter(Boolean))].sort(compareSizes), [rows])
  const groups = useMemo(() => groupMatrixRows(rows), [rows])
  const orders = useMemo(() => groupOrders(rows), [rows])
  const allOrders = useMemo(() => groupOrders(allRows), [allRows])
  const parentCount = new Set(rows.map(row => row.shop_order_id)).size
  const quantity = rows.reduce((sum, row) => sum + Number(row.quantity), 0)
  const toOrderCount = new Set(relevantBatches.filter(batch=>!batch.orderedAt).flatMap(batch=>batch.rows.map(row=>row.shop_order_id))).size
  const shippedCount = new Set(relevantBatches.filter(batch=>batch.orderedAt).flatMap(batch=>batch.rows.map(row=>row.shop_order_id))).size
  const pendingCount = allOrders.filter(order=>!statusFor(order.id)).length
  const observed = view?.observed_at
    ? new Date(view.observed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '待核'
  const title = mode === 'today' ? '今日应发订单' : mode === 'all' ? '全部待发货订单'
    : mode === 'to-order' ? '待下单订单' : '已发货订单'

  return <div className="container py-8 space-y-4 min-h-full">
    <div className="flex items-center justify-between gap-4">
      <Title title={title} description={mode === 'today'
        ? '按承诺发货日期筛选北京时间今天；读取结果仅在本次运行期间展示'
        : mode === 'all' ? '展示当前待发货商品子订单；读取结果仅在本次运行期间展示'
        : '仅表示你在本工具中的临时手动分类；不代表抖店已实际发货，关闭应用或跨日后清空'} />
      {sourceMode && <Button onClick={() => void run('organize')} disabled={busy || !connected}>
        <PlayIcon className="mr-2 h-4 w-4" />{busy ? '整理中…' : '读取全部待发货'}
      </Button>}
    </div>
    {sourceMode && <Card><CardHeader><CardTitle>订单读取</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
      <p className="text-muted-foreground">{connected ? '店铺已登录。' : '请先从“打开店铺订单”连接并登录。'} 读取时逐页核对当前待发货订单；“今日应发”再按承诺发货日期筛选。关闭应用或跨日后需重新读取。</p>
      {result && <p role="status" className={result.ok ? 'text-emerald-700' : 'text-red-700'}>{result.message}</p>}
      <details><summary className="cursor-pointer text-muted-foreground">高级检查</summary>
        <div className="flex flex-wrap gap-2 pt-3">
          <Button variant="outline" size="sm" disabled={busy || !connected} onClick={() => void run('probe')}>检查订单页面</Button>
          <Button variant="outline" size="sm" disabled={busy || !connected} onClick={() => void run('capture')}>只读检查逐页明细</Button>
        </div>
      </details>
    </CardContent></Card>}
    <Card><CardContent className="pt-6">
      {viewError ? <p role="status">待发货订单暂不可读取；请确认应用运行状态。</p>
        : sourceMode && (!view?.available || view.day !== today) ? <p>本次运行尚未读取订单；本机不展示旧快照。</p>
        : <>
          <p className="text-lg font-semibold">{parentCount} 个主订单、{rows.length} 个商品子订单、{quantity} 件</p>
          <p className="mt-2 text-sm text-muted-foreground">{mode === 'today' ? `承诺发货日：${today}（北京时间） · ` : ''}读取时间：{observed} · {view?.page_complete ? '来源页面已读全' : '来源页面未读全'}</p>
          <p className="mt-1 text-sm text-muted-foreground">来源待发货主订单 {view?.source_pending_count ?? '待核'} 个；全部待发货 {view?.displayed_parent_count ?? '待核'} 个；今日应发 {new Set(allRows.filter(row => row.promised_ship_day === today).map(row => row.shop_order_id)).size} 个；店铺 ID：{view?.shop_id_verified ?? '待核'}。这是读取时点结果，不代表实时同步。</p>
          <p className="mt-1 text-sm text-muted-foreground">本机临时分类：待打单 {pendingCount} 单 · 待下单 {toOrderCount} 单 · 已发货 {shippedCount} 单。分类关闭应用或跨日后清空。</p>
          <Button className="mt-4" variant="outline" onClick={() => setShowDetails(value => !value)}>{showDetails ? '收起子订单' : '查看子订单'}</Button>
          {showDetails && <div className="mt-3 max-h-72 overflow-auto space-y-2">{rows.map(row => <div key={row.sku_order_id} className="border-t pt-2 text-xs">
            {row.shop_order_id} / {row.sku_order_id} · {row.merchant_code || row.product_name} · {row.color}/{row.size} · {row.quantity} 件
          </div>)}</div>}
          {rows.length === 0 ? <p className="mt-5">{sourceMode ? '当前列表没有待打单订单；已分类订单可在“待下单订单”或“已发货订单”中查看。' : '当前分类没有订单。'}</p> : <>
            {mode === 'today' && <section className="mt-5 flex flex-wrap items-center gap-3 rounded border p-3" aria-label="今日应发统一打单入口">
              <Button disabled={busy || viewError || orders.length === 0 || !view?.shop_id_verified || !view?.observed_at} onClick={() => setPrintPreview({accountId,shopId:view!.shop_id_verified!,day:today,observedAt:view!.observed_at!,rows:rows.map(row=>({...row}))})}>打单</Button>
              <p className="text-sm text-muted-foreground">实际打印完成后点击：将当前今日应发的 {orders.length} 个主订单、{quantity} 件统一移入“待下单订单”。仅本机标记，不打印、不下单、不通知抖店发货。</p>
            </section>}
            {mode === 'all' && <p className="mt-5 text-sm text-muted-foreground">本页仅查看全部待发货；打单请进入“今日应发订单”，使用唯一的打单入口。</p>}
            {!sourceMode && <section className="mt-5 space-y-3" aria-label="按整批标记履约状态">
              <h2 className="font-semibold">整批操作</h2>
              <p className="text-xs text-muted-foreground">每次点击今日应发“打单”形成一个临时批次；本机标记不更新抖店、ERP或库存。关闭应用或跨日后清空。</p>
              {displayBatches.map(batch=><div key={batch.id} className="flex flex-wrap items-center justify-between gap-3 rounded border p-3">
                <div><p className="font-medium">打单批次：{new Date(batch.printedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</p>
                  <p className="text-sm">{new Set(batch.rows.map(row=>row.shop_order_id)).size} 个主订单 · {batch.rows.length} 个商品子订单 · {batch.rows.reduce((sum,row)=>sum+row.quantity,0)} 件</p>
                  <p className="text-xs text-muted-foreground">{batch.orderedAt ? '已打单并已人工确认下单完成' : '已打单，待确认ERP下单'} · 来源读取：{new Date(batch.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</p>
                </div>
                <div className="flex gap-2">{!batch.orderedAt && <Button size="sm" onClick={()=>completeBatch(batch.id)}>整批下单完成</Button>}
                  <Button size="sm" variant="outline" onClick={()=>restoreBatch(batch.id)}>整批撤回</Button></div>
              </div>)}
            </section>}
            <div className="mt-5 max-h-[70vh] overflow-auto rounded border"><table className="w-full border-collapse text-sm">
              <thead><tr><th className="sticky top-0 z-10 bg-slate-50 p-3 text-left shadow-sm">商家编码或商品名称 · 颜色/款式/原规格</th>
                {sizes.map(size => <th key={size} className="sticky top-0 z-10 bg-slate-50 p-3 text-center shadow-sm">{size}</th>)}
                <th className="sticky top-0 z-10 bg-slate-50 p-3 text-center shadow-sm">源订单数量</th>
                <th className="sticky top-0 z-10 bg-slate-50 p-3 text-center shadow-sm">商品子订单</th></tr></thead>
              <tbody>{groups.map(group => <tr key={group.key} className="border-t">
                <td className="p-3"><div className="font-medium">{group.row.merchant_code || group.row.product_name} · {group.row.variant_role === 'raw_spec' ? '原规格：' : ''}{group.row.color}</div><div className="text-xs text-muted-foreground">{group.row.merchant_code ? '商家编码' : '商家编码未填写；按商品名称展示'}｜商品 ID：{group.row.product_id}{group.row.variant_review_reason ? `｜${group.row.variant_review_reason}` : ''}</div></td>
                {sizes.map(size => <td key={size} className="p-3 text-center">{group.sizes[size] || '—'}</td>)}
                <td className="p-3 text-center">{group.quantity}</td><td className="p-3 text-center">{group.children}</td>
              </tr>)}</tbody></table></div>
          </>}
        </>}
    </CardContent></Card>
    <AlertDialog open={Boolean(printPreview)} onOpenChange={open=>{if(!open)setPrintPreview(null)}}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认这一整批已打单？</AlertDialogTitle>
        <AlertDialogDescription>本批包含 {new Set(printPreview?.rows.map(row=>row.shop_order_id)).size} 个主订单、{printPreview?.rows.length ?? 0} 个商品子订单、{printPreview?.rows.reduce((sum,row)=>sum+row.quantity,0) ?? 0} 件。确认后整批移入“待下单订单”；仅记录你已完成实际打印，不打印、不执行ERP下单或抖店发货。</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction disabled={!printPreview || printPreview.accountId!==accountId || printPreview.day!==today || printPreview.observedAt!==view?.observed_at} onClick={()=>{
        if(!printPreview)return
        try { createPrintBatch(printPreview); setResult({ok:true,message:'整批已移入待下单订单；重复确认不会重复计数。'}) }
        catch(error){ setResult({ok:false,message:error instanceof Error?error.message:'整批标记失败'}) }
        setPrintPreview(null)
      }}>确认整批已打单</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </div>
}
