import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildPlacedDayView, type PlacementView } from './placedOrderView'

describe('placed order size matrix', () => {
  it('sums placed quantities across Beijing-day batches, excluding exceptions and undone batches', () => {
    const placement: PlacementView = { ok: true, ledger: { shop_id: '123456789', batches: [
      { id: 'one', at: '2026-10-27T01:00:00Z', snapshot_observed_at: 'snapshot-one', entries: [
        { shop_order_id: 'parent-one', sku_order_id: 'sku-one', source_quantity: 25, placed_quantity: 20 },
        { shop_order_id: 'parent-two', sku_order_id: 'sku-two', source_quantity: 3, placed_quantity: 3 },
      ] },
      { id: 'two', at: '2026-10-27T05:00:00Z', snapshot_observed_at: 'snapshot-two', entries: [
        { shop_order_id: 'parent-three', sku_order_id: 'sku-three', source_quantity: 4, placed_quantity: 4 },
      ] },
      { id: 'old', at: '2026-10-26T10:00:00Z', snapshot_observed_at: 'snapshot-old', entries: [
        { shop_order_id: 'parent-old', sku_order_id: 'sku-old', source_quantity: 99, placed_quantity: 99 },
      ] },
      { id: 'undone', at: '2026-10-27T06:00:00Z', snapshot_observed_at: 'snapshot-undone', undone_at: '2026-10-27T07:00:00Z', entries: [
        { shop_order_id: 'parent-undone', sku_order_id: 'sku-undone', source_quantity: 50, placed_quantity: 50 },
      ] },
    ] }, order_metadata: {
      'snapshot-one|sku-one': { product_id: 'product', merchant_code: 'TEST-SKU', product_name: '测试商品', color: '黑色', size: '3XL', variant_role: 'color' },
      'snapshot-two|sku-three': { product_id: 'product', merchant_code: 'TEST-SKU', product_name: '测试商品', color: '黑色', size: 'XL', variant_role: 'color' },
    } }
    const view = buildPlacedDayView(placement, '2026-10-27')
    assert.equal(view.batches.length, 2)
    assert.equal(view.count, 27)
    assert.equal(view.resolvedCount, 24)
    assert.equal(view.unresolved.length, 1)
    assert.deepEqual(view.sizes, ['XL', '3XL'])
    assert.equal(view.groups.length, 1)
    assert.equal(view.groups[0].quantity, 24)
    assert.deepEqual(view.groups[0].sizes, { '3XL': 20, XL: 4 })
    assert.equal(view.parents, 3)
  })
})
