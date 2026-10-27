import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PlacementBatch } from './OrderPlacementLedger'

export type PlacedOrderMetadata = { product_id: string; merchant_code: string; product_name: string;
  color: string; size: string; variant_role?: 'color' | 'raw_spec' }

type SnapshotRow = PlacedOrderMetadata & { shop_order_id: string; sku_order_id: string; quantity: number }
type Snapshot = { account_id?: string; shop_id_verified?: string; observed_at?: string;
  scope?: string; page_complete?: boolean; rows?: SnapshotRow[] }

export function placedMetadataKey(observedAt: string, skuOrderId: string): string {
  return `${observedAt}|${skuOrderId}`
}

// Historical snapshots are copied before each successful reorganization. Resolve
// only the exact snapshot and child order used by a confirmed batch.
export async function readPlacedOrderMetadata(root: string, accountId: string, shopId: string,
  batches: PlacementBatch[]): Promise<Record<string, PlacedOrderMetadata>> {
  const wanted = new Map<string, Map<string, PlacementBatch['entries'][number]>>()
  for (const batch of batches.filter(item => !item.undone_at)) {
    const entries = wanted.get(batch.snapshot_observed_at) ?? new Map()
    for (const entry of batch.entries) entries.set(entry.sku_order_id, entry)
    wanted.set(batch.snapshot_observed_at, entries)
  }
  if (!wanted.size) return {}
  let names: string[]
  try { names = await readdir(root) } catch { return {} }
  const metadata: Record<string, PlacedOrderMetadata> = {}
  const conflicts = new Set<string>()
  for (const name of names.filter(item => /^partial_due(?:\.before_\d+)?\.json$/.test(item))) {
    let snapshot: Snapshot
    try { snapshot = JSON.parse(await readFile(path.join(root, name), 'utf8')) as Snapshot }
    catch { continue }
    if (snapshot.account_id !== accountId || String(snapshot.shop_id_verified) !== shopId ||
        snapshot.scope !== 'recent_6_months_pending' || snapshot.page_complete !== true ||
        !snapshot.observed_at || !Array.isArray(snapshot.rows)) continue
    const entries = wanted.get(snapshot.observed_at)
    if (!entries) continue
    for (const row of snapshot.rows) {
      const entry = entries.get(String(row.sku_order_id))
      if (!entry || String(row.shop_order_id) !== entry.shop_order_id ||
          Number(row.quantity) !== entry.source_quantity || !row.product_id || !row.product_name ||
          !row.color || !row.size) continue
      const key = placedMetadataKey(snapshot.observed_at, entry.sku_order_id)
      const value: PlacedOrderMetadata = { product_id: String(row.product_id),
        merchant_code: String(row.merchant_code ?? ''), product_name: String(row.product_name),
        color: String(row.color), size: String(row.size),
        variant_role: row.variant_role === 'color' || row.variant_role === 'raw_spec' ? row.variant_role : undefined }
      if (metadata[key] && JSON.stringify(metadata[key]) !== JSON.stringify(value)) conflicts.add(key)
      else metadata[key] = value
    }
  }
  for (const key of conflicts) delete metadata[key]
  return metadata
}
