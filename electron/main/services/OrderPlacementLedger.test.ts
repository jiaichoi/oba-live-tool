import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { confirmPlacement, placementPreview, readPlacementLedger, undoPlacement,
  validatePlacementSnapshot, writePlacementLedger, type PlacementSnapshot } from './OrderPlacementLedger'

const sample = (observedAt: string): PlacementSnapshot => ({
  account_id: 'demo', shop_id_verified: '123456789', observed_at: observedAt, page_complete: true,
  rows: [
    { shop_order_id: '1234567890123456789', sku_order_id: '2234567890123456789', quantity: 2 },
    { shop_order_id: '1234567890123456789', sku_order_id: '3234567890123456789', quantity: 3 },
  ],
})

describe('local ERP placement record', () => {
  it('keeps the source pending quantity, excludes one size, and appends a second snapshot batch', () => {
    const first = sample('2026-10-26T01:00:00.000Z')
    validatePlacementSnapshot(first, 'demo')
    const empty = { account_id: 'demo', shop_id: '123456789', batches: [] }
    const except = { '3234567890123456789': 3 }
    assert.equal(placementPreview(first, empty, except).to_place, 2)
    const one = confirmPlacement(first, empty, except, first.observed_at)
    assert.equal(one.batch.entries.length, 1)
    assert.equal(one.batch.entries[0].placed_quantity, 2)
    assert.equal(first.rows.reduce((sum, row) => sum + row.quantity, 0), 5)
    assert.equal(placementPreview(first, one.ledger, except).already_confirmed, true)
    assert.throws(() => confirmPlacement(first, one.ledger, except, first.observed_at), /已经确认/)
    const second = sample('2026-10-26T06:00:00.000Z')
    const two = confirmPlacement(second, one.ledger, { '2234567890123456789': 2 }, second.observed_at)
    assert.equal(two.ledger.batches.length, 2)
    assert.equal(two.ledger.batches.flatMap(batch => batch.entries).reduce((sum, row) => sum + row.placed_quantity, 0), 5)
    assert.equal(two.batch.entries[0].sku_order_id, '3234567890123456789')
    assert.equal(undoPlacement(two.ledger, two.batch.id).batches[1].undone_at !== undefined, true)
    const third = sample('2026-10-26T08:00:00.000Z')
    const partial = confirmPlacement(third, two.ledger, { '3234567890123456789': 1 }, third.observed_at)
    assert.equal(partial.batch.entries.find(row => row.sku_order_id === '3234567890123456789')?.placed_quantity, 2)
  })

  it('rejects wrong shop, stale snapshot, invalid exceptions, and persists atomically', async () => {
    const snapshot = sample('2026-10-26T01:00:00.000Z')
    const root = await mkdtemp(path.join(os.tmpdir(), 'oba-placement-test-'))
    const empty = await readPlacementLedger(root, 'demo', '123456789')
    assert.throws(() => placementPreview(snapshot, { ...empty, shop_id: '987654321' }, {}), /不一致/)
    assert.throws(() => confirmPlacement(snapshot, empty, {}, '2026-10-26T02:00:00.000Z'), /已更新/)
    assert.throws(() => placementPreview(snapshot, empty, { '3234567890123456789': 4 }), /超出/)
    const one = confirmPlacement(snapshot, empty, {}, snapshot.observed_at)
    await writePlacementLedger(root, one.ledger)
    const loaded = await readPlacementLedger(root, 'demo', '123456789')
    assert.equal(loaded.batches[0].id, one.batch.id)
    assert.equal(JSON.parse(await readFile(path.join(root, 'placement-ledgers', 'demo_123456789.json'), 'utf8')).batches.length, 1)
  })
})
