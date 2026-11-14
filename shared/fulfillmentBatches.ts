export type BatchRow = {
  shop_order_id: string; sku_order_id: string; product_id: string; product_name: string
  merchant_code: string; color: string; size: string; quantity: number
  platform_created_at: string | null
}
export type FulfillmentBatch = {
  id: string; shop_id: string; created_at: string; day: string; fingerprint: string
  snapshot: BatchRow[]; rows: BatchRow[]; previously_assigned: number
  printed_at?: string; ordered_at?: string; erp_day?: string; erp_slot?: '10:00' | '16:00'
}
export type BatchLedger = { version: 1; account_id: string; batches: FulfillmentBatch[] }
export type BatchResult = { ok: boolean; message?: string; ledger?: BatchLedger }
