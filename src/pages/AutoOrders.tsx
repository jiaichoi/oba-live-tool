import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PlayIcon } from 'lucide-react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog'
import { Title } from '@/components/common/Title'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAccounts } from '@/hooks/useAccounts'
import { compareSizes, groupMatrixRows } from './orderMatrix'
import { isPreviewCurrent, pendingRows, useOrderFulfillmentStore, type BatchInput, type FulfillmentAction } from './orderFulfillmentStore'

type Status = { accountId: string; phase: string; message: string }
type Result = { ok: boolean; message: string }
type DueRow = { shop_order_id: string; sku_order_id: string; merchant_code: string; product_id: string;
  product_name: string; color: string; size: string; quantity: number; promised_ship_day: string;
  variant_role?: 'color' | 'raw_spec'; variant_review_reason?: string }
type DueView = { available: boolean; scope?: string; observed_at?: string; day?: string;
  source_partition?: string; source_status?: string; account_bound?: boolean; page_count?: number;
  page_complete?: boolean; displayed_parent_count?: number; source_pending_count?: number;
  shop_id_verified?: string; rows?: DueRow[] }
type Mode = 'today' | 'all' | 'to-order' | 'manual-shipped'

function currentBeijingDay(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export default function AutoOrders({ mode = 'today' }: { mode?: Mode }) {
  const accountId = useAccounts(state => state.currentAccountId)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [loadedView, setLoadedView] = useState<{ accountId: string; data: DueView } | null>(null)
  const view = loadedView?.accountId === accountId ? loadedView.data : null
  const activeAccount = useRef(accountId)
  const viewRequest = useRef(0)
  activeAccount.current = accountId
  const [viewError, setViewError] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [today, setToday] = useState(currentBeijingDay)
  const marks = useOrderFulfillmentStore(state => state.marks)
  const batches = useOrderFulfillmentStore(state => state.batches)
  const createBatch = useOrderFulfillmentStore(state => state.createBatch)
  const markBatchShipped = useOrderFulfillmentStore(state => state.markBatchShipped)
  const restoreBatch = useOrderFulfillmentStore(state => state.restoreBatch)
  const [preview, setPreview] = useState<BatchInput | null>(null)
  const clearOtherDays = useOrderFulfillmentStore(state => state.clearOtherDays)
  const connected = status?.accountId === accountId && status.phase === 'logged-in-unverified'
  useEffect(() => { clearOtherDays(today) }, [clearOtherDays, today])
  const refreshView = useCallback(async () => {
    const request = ++viewRequest.current
    try {
      const data = await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.getPendingView, accountId) as DueView
      if (request !== viewRequest.current || activeAccount.current !== accountId) return
      setLoadedView({ accountId, data })
      setViewError(false)
    } catch {
      if (request === viewRequest.current && activeAccount.current === accountId) setViewError(true)
    }
  }, [accountId])
  useEffect(() => {
    let active = true
    setResult(null)
    setPreview(null)
    setStatus(null)
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
      if (kind === 'organize') {
        if (value.ok) await refreshView()
        else { setLoadedView(null); setViewError(true) }
      }
    } catch {
      setResult({ ok: false, message: '订单页面读取失败；未保存订单。' })
      if (kind === 'organize') { setLoadedView(null); setViewError(true) }
    }
    finally { setBusy(false) }
  }
  const allRows = view?.available && view.scope === 'pending_and_today_due' && view.day === today && Array.isArray(view.rows) ? view.rows : []
  const scope = { accountId, shopId: view?.shop_id_verified ?? '', day: today }
  const sourceMode = mode === 'today' || mode === 'all'
  const relevantBatches = batches.filter(batch => batch.accountId === accountId && batch.day === today
    && (!scope.shopId || batch.shopId === scope.shopId))
  const displayBatches = relevantBatches.filter(batch => batch.status === (mode === 'to-order' ? 'to-order' : 'shipped'))
  const rows = sourceMode ? pendingRows(allRows, mode, scope, marks) : displayBatches.flatMap(batch => batch.rows)
  const sourceLabel = mode === 'today' ? '今日应发' : '全部待发货'
  const sourceProblem = !view?.available || view.day !== today
    ? '本次运行尚未读取今天的订单，请先读取全部待发货。'
    : view.scope !== 'pending_and_today_due' || view.source_partition !== 'recent_6_months'
      || view.source_status !== 'pending' || view.account_bound !== true || !view.shop_id_verified
      ? '官方筛选范围或店铺身份未核实，已停止分类操作。'
    : !view.page_complete || !Number.isSafeInteger(view.page_count) || (view.page_count ?? 0) < 1
      ? '分页尚未读全，不能将当前页当成全部订单分类。'
    : !Number.isFinite(Date.parse(view.observed_at ?? '')) || !Array.isArray(view.rows)
      ? '订单读取时间或结果无效，请重新读取。'
    : !Number.isSafeInteger(view.source_pending_count) || (view.source_pending_count ?? -1) < 0
      || view.source_pending_count !== view.displayed_parent_count
      || new Set(allRows.map(row => row.shop_order_id)).size !== view.source_pending_count
      ? '官方总数与完整结果不一致，已停止分类操作。'
    : new Set(allRows.map(row => row.sku_order_id)).size !== allRows.length
      || allRows.some(row => !row.shop_order_id || !row.sku_order_id
        || !Number.isSafeInteger(row.quantity) || row.quantity < 1)
      ? '存在重复子订单或无效数量，已停止分类操作。'
    : null
  const canMark = sourceMode && !busy && !viewError && !sourceProblem && Boolean(accountId && rows.length)
  const openPreview = (action: FulfillmentAction) => {
    if (!canMark || !sourceMode) return
    setPreview({ ...scope, observedAt: view!.observed_at!, sourceMode: mode, action, rows: rows.map(row => ({ ...row })) })
  }
  const previewCurrent = Boolean(preview && canMark && sourceMode && today === currentBeijingDay()
    && isPreviewCurrent(preview, { ...scope, sourceMode: mode, observedAt: view?.observed_at ?? '', rows }))
  const sizes = useMemo(() => [...new Set(rows.map(row => row.size).filter(Boolean))].sort(compareSizes), [rows])
  const groups = useMemo(() => groupMatrixRows(rows), [rows])
  const parentCount = new Set(rows.map(row => row.shop_order_id)).size
  const quantity = rows.reduce((sum, row) => sum + Number(row.quantity), 0)
  const toOrderCount = new Set(relevantBatches.filter(batch => batch.status === 'to-order').flatMap(batch => batch.rows.map(row => row.shop_order_id))).size
  const shippedCount = new Set(relevantBatches.filter(batch => batch.status === 'shipped').flatMap(batch => batch.rows.map(row => row.shop_order_id))).size
  const pendingCount = new Set(pendingRows(allRows, 'all', scope, marks).map(row => row.shop_order_id)).size
  const observed = view?.observed_at
    ? new Date(view.observed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '待核'
  const title = mode === 'today' ? '今日应发订单' : mode === 'all' ? '全部待发货订单'
    : mode === 'to-order' ? '待下单' : '已发货订单'

  return <div className="container py-8 space-y-4 min-h-full">
    <div className="flex items-center justify-between gap-4">
      <Title title={title} description={mode === 'today'
        ? '按承诺发货日期筛选北京时间今天；读取结果仅在本次运行期间展示'
        : mode === 'all' ? '官方近6个月待发货的完整读取结果；不包含六个月前订单，仅本次运行有效'
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
      {sourceMode && <section className="mb-5 flex flex-wrap items-center gap-3 rounded border p-3" aria-label={`${sourceLabel}整批人工标记`}>
        <Button disabled={!canMark} onClick={() => openPreview('print')}>打单</Button>
        <Button variant="outline" disabled={!canMark} onClick={() => openPreview('ship')}>发货</Button>
        <p className="text-sm text-muted-foreground">对当前{sourceLabel}列表整批标记：打单归入“待下单”，发货归入“已发货订单”。仅记录人工操作，不打印、不下单、不修改抖店物流；全部待发货支持提前处理；已分类子订单不重复加入。</p>
      </section>}
      {sourceMode && <p className="mb-3 text-sm text-muted-foreground">范围：官方“近6个月订单 → 待发货”，核对所有分页后处理完整结果，不限屏幕当前可见行；不包含六个月前订单。</p>}
      {sourceMode && sourceProblem && <p role="status" className="mb-3 text-sm text-amber-700">{sourceProblem}</p>}
      {viewError ? <p role="status">本次读取失败，已停用分类操作；请重新读取，不能继续使用旧结果。</p>
        : sourceMode && (!view?.available || view.day !== today) ? <p>本次运行尚未读取订单；本机不展示旧快照。</p>
        : <>
          <p className="text-lg font-semibold">{parentCount} 个主订单、{rows.length} 个商品子订单、{quantity} 件</p>
          <p className="mt-2 text-sm text-muted-foreground">{mode === 'today' ? `承诺发货日：${today}（北京时间） · ` : ''}读取时间：{observed} · {view?.page_complete ? '近6个月待发货分页已读全' : '来源页面未读全'}</p>
          <p className="mt-1 text-sm text-muted-foreground">来源待发货主订单 {view?.source_pending_count ?? '待核'} 个；全部待发货 {view?.displayed_parent_count ?? '待核'} 个；今日应发 {new Set(allRows.filter(row => row.promised_ship_day === today).map(row => row.shop_order_id)).size} 个；店铺 ID：{view?.shop_id_verified ?? '待核'}。这是读取时点结果，不代表实时同步。</p>
          <p className="mt-1 text-sm text-muted-foreground">本机临时分类：未标记 {pendingCount} 单 · 待下单 {toOrderCount} 单 · 已发货 {shippedCount} 单。按商品子订单分类，同一主订单可分属不同分类；关闭应用或跨日后清空。</p>
          <Button className="mt-4" variant="outline" onClick={() => setShowDetails(value => !value)}>{showDetails ? '收起子订单' : '查看子订单'}</Button>
          {showDetails && <div className="mt-3 max-h-72 overflow-auto space-y-2">{rows.map(row => <div key={row.sku_order_id} className="border-t pt-2 text-xs">
            {row.shop_order_id} / {row.sku_order_id} · {row.merchant_code || row.product_name} · {row.color}/{row.size} · {row.quantity} 件
          </div>)}</div>}
          {rows.length === 0 ? <p className="mt-5">{sourceMode ? '当前列表没有未标记订单；已分类订单可在“待下单”或“已发货订单”中查看。' : '当前分类没有订单。'}</p> : <>
            {!sourceMode && <section className="mt-5 space-y-3" aria-label="按整批标记履约状态">
              <h2 className="font-semibold">整批操作</h2>
              <p className="text-xs text-muted-foreground">两个来源页面的每次确认形成一个临时批次，保留当时的商品子订单和数量。本机人工标记不代表平台核验；关闭应用或跨日后清空。</p>
              {displayBatches.map(batch=><div key={batch.id} className="flex flex-wrap items-center justify-between gap-3 rounded border p-3">
                <div><p className="font-medium">{batch.status === 'to-order' ? '打单批次' : '已发货批次（人工标记）'}：{new Date(batch.shippedAt ?? batch.markedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</p>
                  <p className="text-sm">{new Set(batch.rows.map(row=>row.shop_order_id)).size} 个主订单 · {batch.rows.length} 个商品子订单 · {batch.rows.reduce((sum,row)=>sum+row.quantity,0)} 件</p>
                  <p className="text-xs text-muted-foreground">{batch.status === 'to-order' ? '人工标记已打单' : batch.printedAt ? '已打单，后人工标记已发货' : '直接人工标记已发货；未记录打单'} · 来源：{batch.sourceMode === 'today' ? '今日应发' : '全部待发货'} · 店铺：{batch.shopId} · 来源读取：{new Date(batch.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</p>
                </div>
                <div className="flex gap-2">{batch.status === 'to-order' && <Button size="sm" onClick={() => markBatchShipped(batch.id)}>已发货</Button>}
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
    <AlertDialog open={Boolean(preview)} onOpenChange={open => { if (!open) setPreview(null) }}>
      <AlertDialogContent><AlertDialogHeader>
        <AlertDialogTitle>{preview?.action === 'ship' ? '将这一整批标记为已发货？' : '确认这一整批已打单？'}</AlertDialogTitle>
        <AlertDialogDescription>官方范围：近6个月订单 → 待发货；不含六个月前订单。来源：{preview?.sourceMode === 'today' ? '今日应发' : '全部待发货'}。本批包含 {new Set(preview?.rows.map(row => row.shop_order_id)).size} 个主订单、{preview?.rows.length ?? 0} 个商品子订单、{preview?.rows.reduce((sum, row) => sum + row.quantity, 0) ?? 0} 件。确认后整批移入“{preview?.action === 'ship' ? '已发货订单' : '待下单'}”。已分类子订单不重复加入。仅记录你的人工标记，不代表平台实际发货，不执行打印、ERP下单或抖店发货。</AlertDialogDescription>
      </AlertDialogHeader>
      {preview && !previewCurrent && <p role="status" className="text-sm text-amber-700">订单范围、店铺、日期或读取结果已变化，请取消后重新确认。</p>}
      <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction disabled={!previewCurrent} onClick={() => {
        if (!preview || !previewCurrent || preview.day !== currentBeijingDay()) return
        try {
          createBatch(preview)
          setResult({ ok: true, message: preview.action === 'ship'
            ? '整批已移入已发货订单；未修改平台物流。'
            : '整批已移入待下单；重复确认不会重复计数。' })
        } catch (error) { setResult({ ok: false, message: error instanceof Error ? error.message : '整批标记失败' }) }
        setPreview(null)
      }}>{preview?.action === 'ship' ? '确认整批已发货（本机标记）' : '确认整批已打单'}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
