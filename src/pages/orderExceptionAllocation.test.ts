import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { allocateExceptionCount, parseExceptionCount } from './orderExceptionAllocation'
import { confirmPlacement } from '../../electron/main/services/OrderPlacementLedger'

describe('matrix exception quantity', () => {
  const members: { sku_order_id: string; quantity: number }[] = [
    { sku_order_id: 'b', quantity: 10 }, { sku_order_id: 'a', quantity: 15 },
  ]

  it('assigns 5 of 25 as exceptions and leaves 20 for the existing ledger', () => {
    const allocated = allocateExceptionCount(members, 5)
    assert.equal(members.reduce((sum, member) => sum + member.quantity - allocated[member.sku_order_id], 0), 20)
    assert.deepEqual(allocated, { a: 5, b: 0 })
    const snapshot = { account_id: 'demo', shop_id_verified: '123456789', observed_at: '2026-10-27T02:00:00Z',
      page_complete: true as const, rows: [
        { shop_order_id: '1234567890123456789', sku_order_id: 'a', quantity: 15 },
        { shop_order_id: '2234567890123456789', sku_order_id: 'b', quantity: 10 },
      ] }
    const confirmed = confirmPlacement(snapshot, { account_id: 'demo', shop_id: '123456789', batches: [] },
      allocated, snapshot.observed_at)
    assert.equal(confirmed.batch.entries.reduce((sum, entry) => sum + entry.placed_quantity, 0), 20)
    assert.equal(confirmed.batch.entries.find(entry => entry.sku_order_id === 'a')?.placed_quantity, 10)
  })

  it('supports zero and full exceptions and ignores order of child rows', () => {
    assert.deepEqual(allocateExceptionCount(members, 0), { a: 0, b: 0 })
    assert.deepEqual(allocateExceptionCount(members, 25), { a: 15, b: 10 })
    assert.deepEqual(allocateExceptionCount([...members].reverse(), 5), allocateExceptionCount(members, 5))
  })

  it('rejects invalid input and does not mix other size cells', () => {
    for (const value of ['', '-1', '1.5', '26', '01', 'abc']) assert.equal(parseExceptionCount(value, 25), null)
    assert.equal(parseExceptionCount('5', 25), 5)
    assert.throws(() => allocateExceptionCount(members, 26))
    const otherSize = { c: 2 }
    assert.deepEqual({ ...otherSize, ...allocateExceptionCount(members, 5) }, { c: 2, a: 5, b: 0 })
  })
})
