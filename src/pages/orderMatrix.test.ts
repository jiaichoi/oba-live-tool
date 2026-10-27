import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareSizes, groupMatrixRows } from './orderMatrix'

describe('shared order matrix layout', () => {
  it('sorts sizes and keeps colors separate under the same product code', () => {
    const base = { product_id: 'product', merchant_code: 'TEST-SKU', product_name: '测试商品', variant_role: 'color' as const }
    const rows = [
      { ...base, color: '黑色', size: '3XL', quantity: 20 },
      { ...base, color: '黑色', size: 'XL', quantity: 4 },
      { ...base, color: '灰色', size: '3XL', quantity: 2 },
    ]
    assert.deepEqual([...new Set(rows.map(row => row.size))].sort(compareSizes), ['XL', '3XL'])
    const groups = groupMatrixRows(rows)
    assert.equal(groups.length, 2)
    assert.equal(groups.find(group => group.row.color === '黑色')?.quantity, 24)
    assert.deepEqual(groups.find(group => group.row.color === '黑色')?.sizes, { '3XL': 20, XL: 4 })
    assert.equal(groups.find(group => group.row.color === '灰色')?.quantity, 2)
  })
})
