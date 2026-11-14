import { create } from 'zustand'

export type OrderFulfillmentStatus = 'to-order' | 'shipped'
export type FulfillmentView = 'pending' | 'to-order' | 'shipped'

export type FulfillmentRow = { shop_order_id: string; sku_order_id: string; merchant_code: string;
  product_id: string; product_name: string; color: string; size: string; quantity: number; promised_ship_day: string;
  variant_role?: 'color' | 'raw_spec'; variant_review_reason?: string }
export type PrintBatch = { id: string; accountId: string; shopId: string; day: string; observedAt: string;
  printedAt: string; orderedAt?: string; rows: FulfillmentRow[] }
type PrintInput = Pick<PrintBatch, 'accountId' | 'shopId' | 'day' | 'observedAt' | 'rows'>
type OrderScope = { accountId: string; day: string; shopOrderId: string }
type State = {
  marks: Record<string, OrderFulfillmentStatus>
  batches: PrintBatch[]
  createPrintBatch: (input: PrintInput) => void
  completeBatch: (id: string) => void
  restoreBatch: (id: string) => void
  markToOrder: (scope: OrderScope) => void
  markManyToOrder: (scopes: OrderScope[]) => void
  markShipped: (scope: OrderScope) => void
  restorePending: (scope: OrderScope) => void
  clearOtherDays: (day: string) => void
}

export function orderScopeKey({ accountId, day, shopOrderId }: OrderScope) {
  return JSON.stringify([accountId, day, shopOrderId])
}

export function filterRowsByFulfillment<T extends { shop_order_id: string }>(
  rows: T[], view: FulfillmentView, statusFor: (shopOrderId: string) => OrderFulfillmentStatus | undefined,
): T[] {
  return rows.filter(row => {
    const status = statusFor(row.shop_order_id)
    return view === 'pending' ? !status : status === view
  })
}

export const useOrderFulfillmentStore = create<State>(set => ({
  marks: {},
  batches: [],
  createPrintBatch: input => set(state => {
    if (!input.accountId || !input.shopId || !input.observedAt) throw new Error('批次来源未核实')
    const marks = { ...state.marks }
    const unique = new Map<string,FulfillmentRow>()
    for (const value of input.rows) {
      if (value.promised_ship_day !== input.day || !Number.isSafeInteger(value.quantity) || value.quantity < 1 || !value.sku_order_id || !value.shop_order_id) throw new Error('批次日期、子订单或数量异常')
      const row: FulfillmentRow = { shop_order_id:value.shop_order_id,sku_order_id:value.sku_order_id,
        merchant_code:value.merchant_code,product_id:value.product_id,product_name:value.product_name,
        color:value.color,size:value.size,quantity:value.quantity,promised_ship_day:value.promised_ship_day,
        variant_role:value.variant_role,variant_review_reason:value.variant_review_reason }
      const previous=unique.get(row.sku_order_id)
      if (previous && JSON.stringify(previous)!==JSON.stringify(row)) throw new Error('同一子订单有冲突，未标记整批')
      unique.set(row.sku_order_id,row)
    }
    const rows = [...unique.values()].filter(row => !marks[orderScopeKey({...input,shopOrderId:row.shop_order_id})])
    if (!rows.length) return state
    for (const row of rows) marks[orderScopeKey({...input,shopOrderId:row.shop_order_id})]='to-order'
    return {marks,batches:[...state.batches,{...input,rows,id:crypto.randomUUID(),printedAt:new Date().toISOString()}]}
  }),
  completeBatch: id => set(state => {
    const batch=state.batches.find(item=>item.id===id)
    if (!batch || batch.orderedAt) return state
    const marks={...state.marks}
    for (const row of batch.rows) marks[orderScopeKey({...batch,shopOrderId:row.shop_order_id})]='shipped'
    return {marks,batches:state.batches.map(item=>item.id===id?{...item,orderedAt:new Date().toISOString()}:item)}
  }),
  restoreBatch: id => set(state => {
    const batch=state.batches.find(item=>item.id===id)
    if (!batch) return state
    const marks={...state.marks}
    for (const row of batch.rows) delete marks[orderScopeKey({...batch,shopOrderId:row.shop_order_id})]
    return {marks,batches:state.batches.filter(item=>item.id!==id)}
  }),
  markToOrder: scope => set(state => ({
    marks: { ...state.marks, [orderScopeKey(scope)]: 'to-order' },
  })),
  markManyToOrder: scopes => set(state => {
    const marks = { ...state.marks }
    for (const scope of scopes) {
      const key = orderScopeKey(scope)
      if (!marks[key]) marks[key] = 'to-order'
    }
    return { marks }
  }),
  markShipped: scope => set(state => ({
    marks: { ...state.marks, [orderScopeKey(scope)]: 'shipped' },
  })),
  restorePending: scope => set(state => {
    const marks = { ...state.marks }
    delete marks[orderScopeKey(scope)]
    return { marks }
  }),
  clearOtherDays: day => set(state => ({
    batches: state.batches.filter(batch=>batch.day===day),
    marks: Object.fromEntries(Object.entries(state.marks).filter(([key]) => {
      try { return JSON.parse(key)[1] === day } catch { return false }
    })),
  })),
}))
