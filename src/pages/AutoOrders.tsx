import { useCallback, useEffect, useMemo, useState } from 'react'
import { PlayIcon } from 'lucide-react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Title } from '@/components/common/Title'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAccounts } from '@/hooks/useAccounts'

type Status = { accountId: string; phase: string; message: string }
type Result = { ok: boolean; message: string; localPath?: string }
type DueRow = { shop_order_id: string; sku_order_id: string; merchant_code: string; product_id: string; product_name: string; color: string; size: string; quantity: number }
type DueView = { available: boolean; scope?: string; observed_at?: string; page_complete?: boolean; displayed_parent_count?: number; rows?: DueRow[] }
const baseSizes = ['M', 'L', 'XL', '2XL', '3XL']

export default function AutoOrders() {
  const accountId = useAccounts(state => state.currentAccountId)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [view, setView] = useState<DueView | null>(null)
  const [viewError, setViewError] = useState(false)
  const connected = status?.phase === 'logged-in-unverified'
  const refreshView = useCallback(async () => {
    try {
      const response = await fetch('http://127.0.0.1:8765/api/pending-view', { cache: 'no-store' })
      if (!response.ok) throw new Error('pending view unavailable')
      setView(await response.json() as DueView)
      setViewError(false)
    } catch { setViewError(true) }
  }, [])
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
    return () => { active = false; remove() }
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
        value = { ok: probe.ok, message: `${probe.message} 页面文字显示待发货 ${probe.visiblePendingMainOrderCount ?? '待核'}。此项只检查页面，不更新矩阵。` }
      }
      setResult(value)
      if (kind === 'organize' && value.ok) await refreshView()
    } catch { setResult({ ok: false, message: '订单页面读取失败；上次结果保持不变。' }) }
    finally { setBusy(false) }
  }
  const rows = view?.available && view.scope === 'recent_6_months_pending' && Array.isArray(view.rows) ? view.rows : []
  const sizes = useMemo(() => [...baseSizes, ...[...new Set(rows.map(row => row.size))]
    .filter(size => size && !baseSizes.includes(size)).sort()], [rows])
  const groups = useMemo(() => {
    const values = new Map<string, { row: DueRow; sizes: Record<string, number>; children: number; quantity: number }>()
    for (const row of rows) {
      const key = [row.product_id, row.merchant_code, row.product_name, row.color].join('|')
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
          <p className="mt-1 text-sm text-muted-foreground">页面当时显示主订单 {view.displayed_parent_count ?? '待核'} 个；店铺 ID 尚待核实。这是读取时点快照，不代表实时同步。</p>
          {rows.length === 0 ? <p className="mt-5">本次待发货 0 单。</p> :
            <div className="mt-5 overflow-x-auto"><table className="w-full border-collapse text-sm">
              <thead><tr className="bg-slate-50"><th className="p-3 text-left">商家编码或商品名称 · 颜色</th>{sizes.map(size => <th key={size} className="p-3 text-center">{size}</th>)}<th className="p-3 text-center">源订单数量</th><th className="p-3 text-center">商品子订单</th></tr></thead>
              <tbody>{groups.map(group => <tr key={[group.row.product_id, group.row.merchant_code, group.row.color].join('|')} className="border-t">
                <td className="p-3"><div className="font-medium">{group.row.merchant_code || group.row.product_name} · {group.row.color}</div><div className="text-xs text-muted-foreground">{group.row.merchant_code ? '商家编码' : '商家编码未填写；按商品名称展示'}｜商品 ID：{group.row.product_id}</div></td>
                {sizes.map(size => <td key={size} className="p-3 text-center">{group.sizes[size] || '—'}</td>)}
                <td className="p-3 text-center">{group.quantity}</td><td className="p-3 text-center">{group.children}</td>
              </tr>)}</tbody></table></div>}
        </>}
    </CardContent></Card>
  </div>
}
