import { useCallback, useEffect, useMemo, useState } from 'react'
import { PlayIcon } from 'lucide-react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Title } from '@/components/common/Title'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAccounts } from '@/hooks/useAccounts'
import { compareSizes, groupMatrixRows } from './orderMatrix'

type Status = { accountId: string; phase: string; message: string }
type Result = { ok: boolean; message: string }
type DueRow = { shop_order_id: string; sku_order_id: string; merchant_code: string; product_id: string;
  product_name: string; color: string; size: string; quantity: number; promised_ship_day: string;
  variant_role?: 'color' | 'raw_spec'; variant_review_reason?: string }
type DueView = { available: boolean; scope?: string; observed_at?: string; day?: string;
  page_complete?: boolean; displayed_parent_count?: number; source_pending_count?: number;
  shop_id_verified?: string; rows?: DueRow[] }

function currentBeijingDay(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export default function AutoOrders() {
  const accountId = useAccounts(state => state.currentAccountId)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [view, setView] = useState<DueView | null>(null)
  const [viewError, setViewError] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [today, setToday] = useState(currentBeijingDay)
  const connected = status?.phase === 'logged-in-unverified'
  useEffect(() => {
    // Remove the old per-snapshot order exception drafts; this view never stores order state.
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index)
      if (key?.startsWith('placement-exceptions:')) localStorage.removeItem(key)
    }
  }, [])
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
  const rows = view?.available && view.scope === 'today_due' && view.day === today && Array.isArray(view.rows) ? view.rows : []
  const sizes = useMemo(() => [...new Set(rows.map(row => row.size).filter(Boolean))].sort(compareSizes), [rows])
  const groups = useMemo(() => groupMatrixRows(rows), [rows])
  const parents = new Set(rows.map(row => row.shop_order_id)).size
  const quantity = rows.reduce((sum, row) => sum + Number(row.quantity), 0)
  const observed = view?.observed_at
    ? new Date(view.observed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '待核'

  return <div className="container py-8 space-y-4 min-h-full">
    <div className="flex items-center justify-between gap-4">
      <Title title="今日应发订单" description="按抖店承诺发货日期筛选北京时间今天；只在本次运行期间展示，不保存订单内容" />
      <Button onClick={() => void run('organize')} disabled={busy || !connected}>
        <PlayIcon className="mr-2 h-4 w-4" />{busy ? '整理中…' : '读取今日应发'}
      </Button>
    </div>
    <Card><CardHeader><CardTitle>订单读取</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
      <p className="text-muted-foreground">{connected ? '店铺已登录。' : '请先从“打开店铺订单”连接并登录。'} 读取时逐页核对当前待发货订单，再按承诺发货日期筛出今天；关闭应用或跨日后需重新读取。</p>
      {result && <p role="status" className={result.ok ? 'text-emerald-700' : 'text-red-700'}>{result.message}</p>}
      <details><summary className="cursor-pointer text-muted-foreground">高级检查</summary>
        <div className="flex flex-wrap gap-2 pt-3">
          <Button variant="outline" size="sm" disabled={busy || !connected} onClick={() => void run('probe')}>检查订单页面</Button>
          <Button variant="outline" size="sm" disabled={busy || !connected} onClick={() => void run('capture')}>只读检查逐页明细</Button>
        </div>
      </details>
    </CardContent></Card>
    <Card><CardContent className="pt-6">
      {viewError ? <p role="status">当天订单暂不可读取；请确认应用运行状态。</p>
        : !view?.available || view.day !== today ? <p>今天尚未读取订单；本机不展示旧快照。</p>
        : <>
          <p className="text-lg font-semibold">{parents} 个主订单、{rows.length} 个商品子订单、{quantity} 件</p>
          <p className="mt-2 text-sm text-muted-foreground">承诺发货日：{today}（北京时间） · 读取时间：{observed} · {view.page_complete ? '来源页面已读全' : '来源页面未读全'}</p>
          <p className="mt-1 text-sm text-muted-foreground">来源待发货主订单 {view.source_pending_count ?? '待核'} 个；今日应发 {view.displayed_parent_count ?? '待核'} 个；店铺 ID：{view.shop_id_verified ?? '待核'}。这是读取时点结果，不代表实时同步。</p>
          <Button className="mt-4" variant="outline" onClick={() => setShowDetails(value => !value)}>{showDetails ? '收起子订单' : '查看子订单'}</Button>
          {showDetails && <div className="mt-3 max-h-72 overflow-auto space-y-2">{rows.map(row => <div key={row.sku_order_id} className="border-t pt-2 text-xs">
            {row.shop_order_id} / {row.sku_order_id} · {row.merchant_code || row.product_name} · {row.color}/{row.size} · {row.quantity} 件
          </div>)}</div>}
          {rows.length === 0 ? <p className="mt-5">今日应发 0 单。</p> :
            <div className="mt-5 max-h-[70vh] overflow-auto rounded border"><table className="w-full border-collapse text-sm">
              <thead><tr><th className="sticky top-0 z-10 bg-slate-50 p-3 text-left shadow-sm">商家编码或商品名称 · 颜色/款式/原规格</th>
                {sizes.map(size => <th key={size} className="sticky top-0 z-10 bg-slate-50 p-3 text-center shadow-sm">{size}</th>)}
                <th className="sticky top-0 z-10 bg-slate-50 p-3 text-center shadow-sm">源订单数量</th>
                <th className="sticky top-0 z-10 bg-slate-50 p-3 text-center shadow-sm">商品子订单</th></tr></thead>
              <tbody>{groups.map(group => <tr key={group.key} className="border-t">
                <td className="p-3"><div className="font-medium">{group.row.merchant_code || group.row.product_name} · {group.row.variant_role === 'raw_spec' ? '原规格：' : ''}{group.row.color}</div><div className="text-xs text-muted-foreground">{group.row.merchant_code ? '商家编码' : '商家编码未填写；按商品名称展示'}｜商品 ID：{group.row.product_id}{group.row.variant_review_reason ? `｜${group.row.variant_review_reason}` : ''}</div></td>
                {sizes.map(size => <td key={size} className="p-3 text-center">{group.sizes[size] || '—'}</td>)}
                <td className="p-3 text-center">{group.quantity}</td><td className="p-3 text-center">{group.children}</td>
              </tr>)}</tbody></table></div>}
        </>}
    </CardContent></Card>
  </div>
}
