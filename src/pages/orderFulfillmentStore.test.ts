import assert from 'node:assert/strict'
import test from 'node:test'
import { pendingRows, rowScopeKey, useOrderFulfillmentStore, type BatchInput } from './orderFulfillmentStore'

const row = (parent: string, child: string, quantity = 1, due = '2026-11-14') => ({
  shop_order_id: parent, sku_order_id: child, quantity, merchant_code: 'DEMO',
  product_id: 'product', product_name: '虚构商品', color: '黑', size: 'L', promised_ship_day: due,
})
const input = (rows = [row('a', 'a1')]): BatchInput => ({
  accountId: 'account-a', shopId: 'shop-a', day: '2026-11-14',
  observedAt: '2026-11-14T02:00:00Z', sourceMode: 'all', action: 'print', rows,
})
const reset = () => useOrderFulfillmentStore.setState({ marks: {}, batches: [] })

test('manual fulfillment batches move between in-memory categories and can be undone', () => {
  reset()
  const selected = input()
  const store = useOrderFulfillmentStore.getState()
  store.createBatch(selected)
  const batch = useOrderFulfillmentStore.getState().batches[0]
  assert.equal(useOrderFulfillmentStore.getState().marks[rowScopeKey(selected, 'a1')], 'to-order')
  store.markBatchShipped(batch.id)
  assert.equal(useOrderFulfillmentStore.getState().marks[rowScopeKey(selected, 'a1')], 'shipped')
  store.restoreBatch(batch.id)
  assert.deepEqual(useOrderFulfillmentStore.getState().marks, {})
})

test('crossing the Beijing day clears old marks and keeps current-day marks', () => {
  reset()
  const store = useOrderFulfillmentStore.getState()
  const old = { ...input(), day: '2026-11-13' }
  const current = input()
  store.createBatch(old)
  store.createBatch(current)
  store.clearOtherDays(current.day)
  const state = useOrderFulfillmentStore.getState()
  assert.equal(state.marks[rowScopeKey(old, 'a1')], undefined)
  assert.equal(state.marks[rowScopeKey(current, 'a1')], 'to-order')
  assert.equal(state.batches.length, 1)
})

test('source views retain unclassified children of a partially classified parent', () => {
  reset()
  const rows = [row('a', 'a1'), row('a', 'a2', 2, '2026-11-15'), row('b', 'b1')]
  const selected = input(rows)
  const store = useOrderFulfillmentStore.getState()
  store.createBatch({ ...selected, sourceMode: 'today', rows: [rows[0], rows[2]] })
  const state = useOrderFulfillmentStore.getState()
  assert.deepEqual(pendingRows(rows, 'all', selected, state.marks).map(item => item.sku_order_id), ['a2'])
  assert.equal(pendingRows(rows, 'all', { ...selected, shopId: 'shop-b' }, state.marks).length, 3)
})

test('whole-list actions are idempotent and never move classified children backwards', () => {
  reset()
  const selected = input([row('a', 'a1', 2), row('a', 'a2', 3, '2026-11-15'), row('b', 'b1')])
  const store = useOrderFulfillmentStore.getState()
  store.createBatch({ ...selected, action: 'ship', rows: [selected.rows[0]] })
  store.createBatch(selected)
  store.createBatch(selected)
  const state = useOrderFulfillmentStore.getState()
  assert.equal(state.batches.length, 2)
  assert.equal(state.marks[rowScopeKey(selected, 'a1')], 'shipped')
  assert.equal(state.marks[rowScopeKey(selected, 'a2')], 'to-order')
  assert.equal(state.batches.flatMap(batch => batch.rows).reduce((sum, item) => sum + item.quantity, 0), 6)
  assert.equal(pendingRows(selected.rows, 'all', selected, state.marks).length, 0)
})

test('a batch keeps multi-item snapshots together through complete, repeat and undo', () => {
  reset()
  const selected = input([row('a', 'a1', 2), row('a', 'a2', 3), row('b', 'b1')])
  const store = useOrderFulfillmentStore.getState()
  store.createBatch(selected)
  store.createBatch(selected)
  const batch = useOrderFulfillmentStore.getState().batches[0]
  assert.equal(batch.rows.length, 3)
  assert.equal(batch.rows.reduce((sum, item) => sum + item.quantity, 0), 6)
  store.markBatchShipped(batch.id)
  store.markBatchShipped(batch.id)
  assert.ok(useOrderFulfillmentStore.getState().batches[0].shippedAt)
  store.restoreBatch(batch.id)
  store.restoreBatch(batch.id)
  assert.equal(useOrderFulfillmentStore.getState().batches.length, 0)
  assert.throws(() => store.createBatch({ ...selected, rows: [row('a', 'a1', 2), row('a', 'a1', 3)] }), /冲突/)
  assert.deepEqual(useOrderFulfillmentStore.getState().marks, {})
})
