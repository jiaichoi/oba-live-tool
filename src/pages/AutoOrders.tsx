import { useCallback, useEffect, useMemo, useState } from 'react'
import { PlayIcon } from 'lucide-react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Title } from '@/components/common/Title'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAccounts } from '@/hooks/useAccounts'
import { allocateExceptionCount, parseExceptionCount } from './orderExceptionAllocation'

type Status = { accountId: string; phase: string; message: string }
type Result = { ok: boolean; message: string; localPath?: string }
type DueRow = { shop_order_id: string; sku_order_id: string; merchant_code: string; product_id: string; product_name: string;
  color: string; size: string; quantity: number; variant_role?: 'color' | 'raw_spec'; variant_review_reason?: string }
type DueView = { available: boolean; scope?: string; observed_at?: string; page_complete?: boolean;
  displayed_parent_count?: number; shop_id_verified?: string; account_bound?: boolean; rows?: DueRow[] }
type PlacementEntry = { sku_order_id: string; source_quantity: number; placed_quantity: number; batch_id: string; placed_at: string }
type PlacementBatch = { id: string; at: string; snapshot_observed_at: string; undone_at?: string; entries: PlacementEntry[] }
type Placement = { ok: boolean; message?: string; observed_at?: string;
  ledger?: { batches: PlacementBatch[] }; preview?: { already_confirmed: boolean } }
function sizeOrder(value: string): [number, number | string] {
  const size = value.toUpperCase()
  const known: Record<string, number> = { XS: 0, S: 1, M: 2, L: 3, XL: 4 }
  if (size in known) return [0, known[size]]
  const multiple = size.match(/^(\d{1,2})XL$/)
  if (multiple) return [0, 3 + Number(multiple[1])]
  const numeric = size.match(/^(\d{2,3})(?:CM|厘米|码)$/)
  if (numeric) return [1, Number(numeric[1])]
  return [2, size]
}

function compareSizes(a: string, b: string): number {
  const left = sizeOrder(a)
  const right = sizeOrder(b)
  return left[0] - right[0] || (typeof left[1] === 'number' && typeof right[1] === 'number'
    ? left[1] - right[1] : String(left[1]).localeCompare(String(right[1]), 'zh-CN'))
}

export default function AutoOrders() {
  const accountId = useAccounts(state => state.currentAccountId)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [view, setView] = useState<DueView | null>(null)
  const [viewError, setViewError] = useState(false)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [exceptions, setExceptions] = useState<Record<string, number>>({})
  const [cellDrafts, setCellDrafts] = useState<Record<string, string>>({})
  const [invalidCells, setInvalidCells] = useState<Record<string, boolean>>({})
  const [showDetails, setShowDetails] = useState(false)
  const connected = status?.phase === 'logged-in-unverified'
  const refreshView = useCallback(async () => {
    try {
      setView(await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.getPendingView, accountId) as DueView)
      setViewError(false)
    } catch { setViewError(true) }
  }, [accountId])
  const refreshPlacement = useCallback(async () => {
    setPlacement(await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.getPlacement, accountId) as Placement)
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
    void refreshPlacement()
    return () => { active = false; remove() }
  }, [accountId, refreshView, refreshPlacement])
  const run = async (kind: 'organize' | 'probe' | 'capture') => {
    setBusy(true)
    setResult(null)
    try {
      let value: Result
      if (kind === 'organize') value = await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.organizePending, accountId)
      else if (kind === 'capture') value = await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.capturePendingRows, accountId)
      else {
        const probe = await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.probeOrderPage, accountId)
        value = { ok: probe.ok, message: `${probe.message} 页面文字显示待发货 ${probe.visiblePendingMainOrderCount ?? '待核'}。此项只检查页面，不更新矩阵。` }
      }
      setResult(value)
      if (kind === 'organize' && value.ok) { await refreshView(); await refreshPlacement() }
    } catch { setResult({ ok: false, message: '订单页面读取失败；上次结果保持不变。' }) }
    finally { setBusy(false) }
  }
  const rows = view?.available && view.scope === 'recent_6_months_pending' && Array.isArray(view.rows) ? view.rows : []
  const draftKey = view?.account_bound && view?.observed_at && view?.shop_id_verified
    ? `placement-exceptions:${accountId}:${view.shop_id_verified}:${view.observed_at}` : ''
  useEffect(() => {
    setCellDrafts({})
    setInvalidCells({})
    if (!draftKey) { setExceptions({}); return }
    try { setExceptions(JSON.parse(localStorage.getItem(draftKey) || '{}') as Record<string, number>) }
    catch { setExceptions({}) }
  }, [draftKey])
  const setException = (id: string, count: number) => {
    if (!Number.isSafeInteger(count) || count < 0) return
    const next = { ...exceptions, [id]: count }
    setExceptions(next)
    setCellDrafts({})
    setInvalidCells({})
    if (draftKey) localStorage.setItem(draftKey, JSON.stringify(next))
  }
  const setCellException = (key: string, members: DueRow[], sourceQuantity: number, value: string) => {
    setCellDrafts(current => ({ ...current, [key]: value }))
    const count = parseExceptionCount(value, sourceQuantity)
    setInvalidCells(current => ({ ...current, [key]: count === null }))
    if (count === null) return
    const next = { ...exceptions, ...allocateExceptionCount(members, count) }
    setExceptions(next)
    if (draftKey) localStorage.setItem(draftKey, JSON.stringify(next))
  }
  const alreadyConfirmed = Boolean(placement?.preview?.already_confirmed)
  const hasInvalidCell = Object.values(invalidCells).some(Boolean)
  const toPlace = alreadyConfirmed ? 0 : rows.reduce((sum, row) => sum + Math.max(0,
    Number(row.quantity) - (exceptions[row.sku_order_id] ?? 0)), 0)
  const exceptionCount = rows.reduce((sum, row) => sum + (exceptions[row.sku_order_id] ?? 0), 0)
  const confirm = async () => {
    if (!placement?.ok || !view?.observed_at || !toPlace || alreadyConfirmed || hasInvalidCell) return
    if (!window.confirm(`请确认这些订单已经在 ERP 人工下单。\n本次标记 ${toPlace} 件已下单，${exceptionCount} 件本次不下单。\n此操作只记录本机状态，不会在 ERP 创建订单。`)) return
    setBusy(true)
    try {
      const value = await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.confirmPlacement,
        accountId, view.observed_at, exceptions) as Result
      setResult(value)
      await refreshPlacement()
    } catch { setResult({ ok: false, message: '本地下单确认失败；请重新检查。' }) }
    finally { setBusy(false) }
  }
  const undo = async (id: string) => {
    if (!window.confirm('只撤销本机标记，不会撤销 ERP 真实订单。确定继续？')) return
    const value = await window.ipcRenderer.invoke(IPC_CHANNELS.orderExport.undoPlacement, accountId, id) as Result
    setResult(value); await refreshPlacement()
  }
  const sizes = useMemo(() => [...new Set(rows.map(row => row.size).filter(Boolean))].sort(compareSizes), [rows])
  const groups = useMemo(() => {
    const values = new Map<string, { row: DueRow; sizes: Record<string, number>; children: number; quantity: number }>()
    for (const row of rows) {
      const key = JSON.stringify([row.product_id, row.merchant_code, row.product_name, row.color, row.variant_role])
      const group = values.get(key) ?? { row, sizes: {}, children: 0, quantity: 0 }
      group.sizes[row.size] = (group.sizes[row.size] ?? 0) + Number(row.quantity)
      group.children += 1
      group.quantity += Number(row.quantity)
      values.set(key, group)
    }
    return [...values.values()].sort((a, b) => (a.row.merchant_code || a.row.product_name)
      .localeCompare(b.row.merchant_code || b.row.product_name, 'zh-CN'))
  }, [rows])
  const parents = new Set(rows.map(row => row.shop_order_id)).size
  const quantity = rows.reduce((total, row) => total + Number(row.quantity), 0)
  const observed = view?.observed_at ? new Date(view.observed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '待核'

  return <div className="container py-8 space-y-4 min-h-full">
    <div className="flex items-center justify-between gap-4">
      <Title title="自动整理订单" description="整理执行时店铺仍待发货的订单；查询范围为近6个月，不限今天下单" />
      <Button onClick={() => void run('organize')} disabled={busy || !connected}>
        <PlayIcon className="mr-2 h-4 w-4" />{busy ? '整理中…' : '开始整理'}
      </Button>
    </div>
    <Card><CardHeader><CardTitle>订单整理</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
      <p className="text-muted-foreground">{connected ? '店铺已登录。' : '请先从“打开店铺订单”连接并登录。'} 日常只需点击“开始整理”；核对失败时保留上次快照。</p>
      {result && <div role="status" className={result.ok ? 'text-emerald-700' : 'text-red-700'}>
        <p>{result.message}</p>{result.localPath && <p>候选文件已保存在本机；尚未发布到矩阵。</p>}
      </div>}
      <details><summary className="cursor-pointer text-muted-foreground">高级检查</summary>
        <div className="flex flex-wrap gap-2 pt-3">
          <Button variant="outline" size="sm" disabled={busy || !connected} onClick={() => void run('probe')}>检查订单页面</Button>
          <Button variant="outline" size="sm" disabled={busy || !connected} onClick={() => void run('capture')}>保存逐页候选明细</Button>
        </div>
      </details>
    </CardContent></Card>
    <Card><CardContent className="pt-6">
      {viewError ? <p role="status">本机订单结果暂不可读取；请确认工作台服务正在运行。</p>
        : !view?.available ? <p>尚无已核验的待发货结果。</p>
        : <>
          <p className="text-lg font-semibold">{parents} 个主订单、{rows.length} 个商品子订单、源订单数量 {quantity}</p>
          <p className="mt-2 text-sm text-muted-foreground">读取时间：{observed}（北京时间） · 范围：近6个月待发货 · {view.page_complete ? '本次页面已读全' : '部分已读取'}</p>
          <p className="mt-1 text-sm text-muted-foreground">页面当时显示主订单 {view.displayed_parent_count ?? '待核'} 个；店铺 ID：{view.shop_id_verified ?? '待核'}。这是读取时点快照，不代表实时同步。</p>
          <div className="mt-4 rounded-lg border p-4 space-y-2">
            <p className="font-semibold">ERP 人工下单进度</p>
            <p className="text-sm">待发货原始数量始终为 {quantity} 件；本次可确认 {toPlace} 件，本次不下单 {exceptionCount} 件。每次重新整理形成新批次，不自动扣除此前已下单记录。</p>
            {!view.account_bound || !placement?.ok ? <p role="status" className="text-amber-700">{placement?.message || '当前快照未绑定本机账号；请先重新整理订单。'}</p> : null}
            {alreadyConfirmed && <p role="status" className="text-emerald-700">这次整理快照已确认。若今天还有新一轮 ERP 下单，请先点“开始整理”获取新快照。</p>}
            <p className="text-xs text-muted-foreground">直接在尺码格填写“本次不下单”件数，范围为 0 到该格源订单数量；可确认数量会随之更新。请先在 ERP 完成人工下单，再确认。</p>
            <div className="flex gap-2"><Button variant="outline" onClick={() => setShowDetails(value => !value)}>{showDetails ? '收起子订单' : '查看子订单与部分例外'}</Button>
              <Button disabled={busy || !placement?.ok || !toPlace || alreadyConfirmed || hasInvalidCell} onClick={() => void confirm()}>完成下单</Button></div>
            {showDetails && <div className="max-h-72 overflow-auto space-y-2">{rows.map(row => <div key={row.sku_order_id} className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs">
              <span>{row.shop_order_id} / {row.sku_order_id} · {row.merchant_code || row.product_name} · {row.color}/{row.size} · {row.quantity} 件</span>
              <label>本次不下单 <input className="w-16 rounded border p-1" type="number" min="0" max={row.quantity} step="1" value={exceptions[row.sku_order_id] ?? 0}
                onChange={event => { const count = parseExceptionCount(event.target.value, row.quantity); if (count !== null) setException(row.sku_order_id, count) }} /></label>
            </div>)}</div>}
            {(placement?.ledger?.batches ?? []).filter(batch => !batch.undone_at).slice(-1).map(batch =>
              <Button key={batch.id} variant="ghost" size="sm" onClick={() => void undo(batch.id)}>撤销最近一次本机确认</Button>)}
          </div>
          {rows.length === 0 ? <p className="mt-5">本次待发货 0 单。</p> :
            <div className="mt-5 overflow-x-auto"><table className="w-full border-collapse text-sm">
              <thead><tr className="bg-slate-50"><th className="p-3 text-left">商家编码或商品名称 · 颜色/款式/原规格</th>{sizes.map(size => <th key={size} className="p-3 text-center">{size}</th>)}<th className="p-3 text-center">源订单数量</th><th className="p-3 text-center">商品子订单</th></tr></thead>
              <tbody>{groups.map(group => <tr key={JSON.stringify([group.row.product_id, group.row.merchant_code, group.row.product_name, group.row.color, group.row.variant_role])} className="border-t">
                <td className="p-3"><div className="font-medium">{group.row.merchant_code || group.row.product_name} · {group.row.variant_role === 'raw_spec' ? '原规格：' : ''}{group.row.color}</div><div className="text-xs text-muted-foreground">{group.row.merchant_code ? '商家编码' : '商家编码未填写；按商品名称展示'}｜商品 ID：{group.row.product_id}{group.row.variant_review_reason ? `｜${group.row.variant_review_reason}` : ''}</div></td>
                {sizes.map(size => {
                  const members = rows.filter(row => row.product_id === group.row.product_id && row.merchant_code === group.row.merchant_code &&
                    row.product_name === group.row.product_name && row.color === group.row.color && row.variant_role === group.row.variant_role && row.size === size)
                  const count = group.sizes[size] || 0
                  const excepted = members.reduce((sum, row) => sum + (exceptions[row.sku_order_id] ?? 0), 0)
                  const cellKey = JSON.stringify([group.row.product_id, group.row.merchant_code, group.row.product_name,
                    group.row.color, group.row.variant_role, size])
                  return <td key={size} className="p-3 text-center">{count ? <div className="flex min-w-28 flex-col items-center gap-1">
                    <span>源 {count} 件</span>
                    <label className="flex items-center gap-1 whitespace-nowrap">例外
                      <input type="number" inputMode="numeric" min="0" max={count} step="1" aria-label={`${group.row.merchant_code || group.row.product_name} ${group.row.color} ${size} 本次不下单件数`}
                        aria-invalid={Boolean(invalidCells[cellKey])} className={`w-14 rounded border p-1 text-center ${invalidCells[cellKey] ? 'border-red-500' : ''}`}
                        disabled={!placement?.ok || alreadyConfirmed} value={cellDrafts[cellKey] ?? excepted}
                        onChange={event => setCellException(cellKey, members, count, event.target.value)}
                        onBlur={() => { if (invalidCells[cellKey]) { setCellDrafts(current => { const next = { ...current }; delete next[cellKey]; return next }); setInvalidCells(current => { const next = { ...current }; delete next[cellKey]; return next }) } }} />
                    </label>
                    <span className="text-xs text-muted-foreground">可确认 {count - excepted} 件</span>
                    {invalidCells[cellKey] && <span role="alert" className="text-xs text-red-700">填 0 至 {count} 的整数</span>}
                  </div> : '—'}</td>
                })}
                <td className="p-3 text-center">{group.quantity}</td><td className="p-3 text-center">{group.children}</td>
              </tr>)}</tbody></table></div>}
        </>}
    </CardContent></Card>
  </div>
}
