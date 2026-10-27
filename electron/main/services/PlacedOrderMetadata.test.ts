import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { placedMetadataKey, readPlacedOrderMetadata } from './PlacedOrderMetadata'
import type { PlacementBatch } from './OrderPlacementLedger'

describe('historical placed order dimensions', () => {
  it('joins each confirmed entry to its own complete, account-bound snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oba-placed-matrix-'))
    const observedAt = '2026-10-27T02:00:00.000Z'
    const batch: PlacementBatch = { id: 'batch-1', at: '2026-10-27T03:00:00.000Z',
      snapshot_observed_at: observedAt, entries: [{ batch_id: 'batch-1', placed_at: '2026-10-27T03:00:00.000Z',
        shop_order_id: '1234567890123456789', sku_order_id: '2234567890123456789', source_quantity: 25,
        placed_quantity: 20 }] }
    const snapshot = { account_id: 'default', shop_id_verified: '123456789', observed_at: observedAt,
      scope: 'recent_6_months_pending', page_complete: true,
      rows: [{ shop_order_id: '1234567890123456789', sku_order_id: '2234567890123456789', quantity: 25,
        product_id: '9999999999999999999', merchant_code: 'TEST-SKU', product_name: '测试商品',
        color: '【女款】黑色', size: '3XL', variant_role: 'color' }] }
    await writeFile(path.join(root, 'partial_due.before_1.json'), JSON.stringify(snapshot))
    await writeFile(path.join(root, 'partial_due.json'), JSON.stringify({ ...snapshot, account_id: 'other' }))
    const found = await readPlacedOrderMetadata(root, 'default', '123456789', [batch])
    assert.deepEqual(found[placedMetadataKey(observedAt, '2234567890123456789')], {
      product_id: '9999999999999999999', merchant_code: 'TEST-SKU', product_name: '测试商品',
      color: '【女款】黑色', size: '3XL', variant_role: 'color',
    })
    assert.deepEqual(await readPlacedOrderMetadata(root, 'default', '123456789', [{ ...batch,
      entries: [{ ...batch.entries[0], source_quantity: 24 }] }]), {})
    await writeFile(path.join(root, 'partial_due.before_2.json'), JSON.stringify({ ...snapshot,
      rows: [{ ...snapshot.rows[0], color: '灰色' }] }))
    assert.deepEqual(await readPlacedOrderMetadata(root, 'default', '123456789', [batch]), {})
  })
})
