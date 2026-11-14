import { create } from 'zustand'

export type FulfillmentAction = 'print' | 'ship'
export type SourceMode = 'today' | 'all'
export type FulfillmentStatus = 'to-order' | 'shipped'
export type FulfillmentRow = {
  shop_order_id: string; sku_order_id: string; merchant_code: string; product_id: string
  product_name: string; color: string; size: string; quantity: number; promised_ship_day: string
  variant_role?: 'color' | 'raw_spec'; variant_review_reason?: string
}
export type FulfillmentScope = { accountId: string; shopId: string; day: string }
export type BatchInput = FulfillmentScope & {
  observedAt: string; sourceMode: SourceMode; action: FulfillmentAction; rows: FulfillmentRow[]
}
export type FulfillmentBatch = BatchInput & {
  id: string; status: FulfillmentStatus; markedAt: string; printedAt?: string; shippedAt?: string
}

export function rowScopeKey(scope: FulfillmentScope, skuOrderId: string): string {
  return JSON.stringify([scope.accountId, scope.shopId, scope.day, skuOrderId])
}

export function pendingRows(
  rows: FulfillmentRow[], mode: SourceMode, scope: FulfillmentScope,
  marks: Record<string, FulfillmentStatus>,
): FulfillmentRow[] {
  return rows.filter(row => (mode === 'all' || row.promised_ship_day === scope.day)
    && !marks[rowScopeKey(scope, row.sku_order_id)])
}

export function isPreviewCurrent(preview: BatchInput, current: Omit<BatchInput, 'action'>): boolean {
  return preview.accountId === current.accountId && preview.shopId === current.shopId
    && preview.day === current.day && preview.observedAt === current.observedAt
    && preview.sourceMode === current.sourceMode && JSON.stringify(preview.rows) === JSON.stringify(current.rows)
}

type State = {
  marks: Record<string, FulfillmentStatus>
  batches: FulfillmentBatch[]
  createBatch: (input: BatchInput) => void
  markBatchShipped: (id: string) => void
  restoreBatch: (id: string) => void
  clearOtherDays: (day: string) => void
}

export const useOrderFulfillmentStore = create<State>(set => ({
  marks: {},
  batches: [],
  createBatch: input => set(state => {
    if (!input.accountId || !input.shopId || !/^\d{4}-\d{2}-\d{2}$/.test(input.day)
      || !Number.isFinite(Date.parse(input.observedAt))) throw new Error('批次来源或标记日期未核实')
    if (!['today', 'all'].includes(input.sourceMode) || !['print', 'ship'].includes(input.action)) {
      throw new Error('批次来源范围或标记类型异常')
    }
    const unique = new Map<string, FulfillmentRow>()
    for (const value of input.rows) {
      if ((input.sourceMode === 'today' && value.promised_ship_day !== input.day)
        || !Number.isSafeInteger(value.quantity) || value.quantity < 1
        || !value.sku_order_id || !value.shop_order_id) throw new Error('批次日期、子订单或数量异常')
      const row = { ...value }
      const previous = unique.get(row.sku_order_id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('同一子订单有冲突，未标记整批')
      unique.set(row.sku_order_id, row)
    }
    const rows = [...unique.values()].filter(row => !state.marks[rowScopeKey(input, row.sku_order_id)])
    if (!rows.length) return state
    const status = input.action === 'print' ? 'to-order' : 'shipped'
    const marks = { ...state.marks }
    for (const row of rows) marks[rowScopeKey(input, row.sku_order_id)] = status
    const now = new Date().toISOString()
    const batch: FulfillmentBatch = {
      ...input, rows, id: crypto.randomUUID(), status, markedAt: now,
      ...(input.action === 'print' ? { printedAt: now } : { shippedAt: now }),
    }
    return { marks, batches: [...state.batches, batch] }
  }),
  markBatchShipped: id => set(state => {
    const batch = state.batches.find(item => item.id === id)
    if (!batch || batch.status === 'shipped') return state
    const marks = { ...state.marks }
    for (const row of batch.rows) marks[rowScopeKey(batch, row.sku_order_id)] = 'shipped'
    return {
      marks,
      batches: state.batches.map(item => item.id === id
        ? { ...item, status: 'shipped', shippedAt: new Date().toISOString() } : item),
    }
  }),
  restoreBatch: id => set(state => {
    const batch = state.batches.find(item => item.id === id)
    if (!batch) return state
    const marks = { ...state.marks }
    for (const row of batch.rows) delete marks[rowScopeKey(batch, row.sku_order_id)]
    return { marks, batches: state.batches.filter(item => item.id !== id) }
  }),
  clearOtherDays: day => set(state => ({
    batches: state.batches.filter(batch => batch.day === day),
    marks: Object.fromEntries(Object.entries(state.marks).filter(([key]) => {
      try { return JSON.parse(key)[2] === day } catch { return false }
    })),
  })),
}))
