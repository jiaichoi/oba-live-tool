import assert from 'node:assert/strict'
import test from 'node:test'
import { filterRowsByFulfillment, orderScopeKey, useOrderFulfillmentStore } from './orderFulfillmentStore'

test('manual fulfillment marks move an order between in-memory categories and can be undone', () => {
  const scope = { accountId: 'account-a', day: '2026-11-14', shopOrderId: 'order-1' }
  useOrderFulfillmentStore.getState().restorePending(scope)
  useOrderFulfillmentStore.getState().markToOrder(scope)
  assert.equal(useOrderFulfillmentStore.getState().marks[orderScopeKey(scope)], 'to-order')
  useOrderFulfillmentStore.getState().markShipped(scope)
  assert.equal(useOrderFulfillmentStore.getState().marks[orderScopeKey(scope)], 'shipped')
  useOrderFulfillmentStore.getState().restorePending(scope)
  assert.equal(useOrderFulfillmentStore.getState().marks[orderScopeKey(scope)], undefined)
})

test('crossing the Beijing day clears old marks and keeps current-day marks', () => {
  const oldScope = { accountId: 'account-a', day: '2026-11-13', shopOrderId: 'old-order' }
  const currentScope = { accountId: 'account-b', day: '2026-11-14', shopOrderId: 'current-order' }
  useOrderFulfillmentStore.getState().markShipped(oldScope)
  useOrderFulfillmentStore.getState().markToOrder(currentScope)
  useOrderFulfillmentStore.getState().clearOtherDays('2026-11-14')
  const marks = useOrderFulfillmentStore.getState().marks
  assert.equal(marks[orderScopeKey(oldScope)], undefined)
  assert.equal(marks[orderScopeKey(currentScope)], 'to-order')
})

test('source views hide an entire marked main order and category views retain all its item lines', () => {
  const lines = [
    { shop_order_id: 'order-1', sku_order_id: 'line-a' },
    { shop_order_id: 'order-1', sku_order_id: 'line-b' },
    { shop_order_id: 'order-2', sku_order_id: 'line-c' },
  ]
  const scope = { accountId: 'account-a', day: '2026-11-14', shopOrderId: 'order-1' }
  useOrderFulfillmentStore.getState().markToOrder(scope)
  const statusFor = (shopOrderId: string) => useOrderFulfillmentStore.getState().marks[
    orderScopeKey({ ...scope, shopOrderId })
  ]
  assert.deepEqual(filterRowsByFulfillment(lines, 'pending', statusFor).map(row => row.sku_order_id), ['line-c'])
  assert.deepEqual(filterRowsByFulfillment(lines, 'to-order', statusFor).map(row => row.sku_order_id), ['line-a', 'line-b'])
  useOrderFulfillmentStore.getState().restorePending(scope)
})

test('single today action is idempotent and never moves completed or unselected orders backwards', () => {
  const scope = (id: string) => ({ accountId: 'bulk-verification', day: '2026-11-14', shopOrderId: id })
  const store = useOrderFulfillmentStore.getState()
  store.markShipped(scope('done'))
  store.markManyToOrder([scope('today-a'), scope('today-b'), scope('today-a'), scope('done')])
  store.markManyToOrder([scope('today-a'), scope('today-b')])
  const marks = useOrderFulfillmentStore.getState().marks
  assert.equal(marks[orderScopeKey(scope('today-a'))], 'to-order')
  assert.equal(marks[orderScopeKey(scope('today-b'))], 'to-order')
  assert.equal(marks[orderScopeKey(scope('done'))], 'shipped')
  assert.equal(marks[orderScopeKey(scope('future'))], undefined)
  const lines = [{shop_order_id:'today-a',quantity:2},{shop_order_id:'today-a',quantity:3},
    {shop_order_id:'today-b',quantity:1},{shop_order_id:'future',quantity:4}]
  const selected = filterRowsByFulfillment(lines, 'to-order', id => marks[orderScopeKey(scope(id))])
  assert.equal(selected.reduce((sum,row)=>sum+row.quantity,0), 6)
  for (const id of ['today-a','today-b','done']) store.restorePending(scope(id))
})

test('a print batch keeps multi-item snapshots together through complete, repeat and undo', () => {
  const row=(parent:string,child:string,quantity:number)=>({shop_order_id:parent,sku_order_id:child,quantity,
    merchant_code:'DEMO',product_id:'product',product_name:'虚构验收',color:'黑',size:'L',promised_ship_day:'2026-11-14'})
  const input={accountId:'batch-test',shopId:'test-shop',day:'2026-11-14',observedAt:'2026-11-14T02:00:00Z',rows:[row('a','a1',2),row('a','a2',3),row('b','b1',1)]}
  const store=useOrderFulfillmentStore.getState()
  store.createPrintBatch(input);store.createPrintBatch(input)
  const batches=useOrderFulfillmentStore.getState().batches.filter(b=>b.accountId===input.accountId)
  assert.equal(batches.length,1); assert.equal(batches[0].rows.length,3)
  assert.equal(batches[0].rows.reduce((sum,r)=>sum+r.quantity,0),6)
  store.completeBatch(batches[0].id);store.completeBatch(batches[0].id)
  assert.ok(useOrderFulfillmentStore.getState().batches.find(b=>b.id===batches[0].id)?.orderedAt)
  assert.equal(useOrderFulfillmentStore.getState().marks[orderScopeKey({...input,shopOrderId:'a'})],'shipped')
  store.restoreBatch(batches[0].id);store.restoreBatch(batches[0].id)
  assert.equal(useOrderFulfillmentStore.getState().batches.some(b=>b.id===batches[0].id),false)
  assert.equal(useOrderFulfillmentStore.getState().marks[orderScopeKey({...input,shopOrderId:'a'})],undefined)
  assert.throws(()=>store.createPrintBatch({...input,rows:[row('a','a1',2),row('a','a1',3)]}),/冲突/)
  assert.equal(useOrderFulfillmentStore.getState().marks[orderScopeKey({...input,shopOrderId:'a'})],undefined)
})
