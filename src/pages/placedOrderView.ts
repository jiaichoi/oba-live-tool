import { compareSizes, groupMatrixRows } from './orderMatrix'

export type PlacedEntry = { shop_order_id: string; sku_order_id: string; placed_quantity: number; source_quantity: number }
export type PlacedBatch = { id: string; at: string; snapshot_observed_at: string; undone_at?: string; entries: PlacedEntry[] }
export type PlacedMetadata = { product_id: string; merchant_code: string; product_name: string;
  color: string; size: string; variant_role?: 'color' | 'raw_spec' }
export type PlacementView = { ok: boolean; message?: string; ledger?: { shop_id: string; batches: PlacedBatch[] };
  order_metadata?: Record<string, PlacedMetadata> }

export const beijingDay = (iso: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric',
    month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso))
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export function buildPlacedDayView(placement: PlacementView | null, day: string) {
  const batches = (placement?.ledger?.batches ?? [])
    .filter(batch => !batch.undone_at && beijingDay(batch.at) === day)
  const entries = batches.flatMap(batch => batch.entries.map(entry => ({ ...entry, batchId: batch.id,
    at: batch.at, snapshotObservedAt: batch.snapshot_observed_at })))
  const resolved = entries.flatMap(entry => {
    const metadata = placement?.order_metadata?.[`${entry.snapshotObservedAt}|${entry.sku_order_id}`]
    return metadata ? [{ ...entry, ...metadata, quantity: entry.placed_quantity }] : []
  })
  const unresolved = entries.filter(entry => !placement?.order_metadata?.[`${entry.snapshotObservedAt}|${entry.sku_order_id}`])
  const sizes = [...new Set(resolved.map(row => row.size))].sort(compareSizes)
  const groups = groupMatrixRows(resolved)
  const count = entries.reduce((sum, entry) => sum + entry.placed_quantity, 0)
  const resolvedCount = resolved.reduce((sum, entry) => sum + entry.placed_quantity, 0)
  const parents = new Set(entries.map(entry => entry.shop_order_id)).size
  return { batches, entries, resolved, unresolved, sizes, groups, count, resolvedCount, parents }
}
