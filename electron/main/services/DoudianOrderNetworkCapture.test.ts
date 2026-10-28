import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { it } from 'node:test'
import type { Page, Response } from 'playwright'
import { observeOrderResponses, sanitizeOrderResponse } from './DoudianOrderNetworkCapture'

it('retains order fields without buyer contacts or auth material', () => {
  const raw = { data: { orders: [{ shopOrderId: '1234567890123456789', skuOrderId: '2234567890123456789',
    merchantCode: '54629BNYA', expectShipTime: 1792912800, buyerPhone: '13800138000',
    receiverAddress: 'private', accessToken: 'secret', note: 'private', productName: '羊毛裤' }] } }
  const cleaned = sanitizeOrderResponse(raw)
  assert.equal(JSON.stringify(cleaned).includes('54629BNYA'), true)
  for (const secret of ['13800138000', 'receiverAddress', 'accessToken', 'private'])
    assert.equal(JSON.stringify(cleaned).includes(secret), false)
})

it('retains only named SKU property values inside specification objects', () => {
  const cleaned = sanitizeOrderResponse({ data: [{ product_item: [{
    sku_properties: [{ name: '颜色分类', value: '雾松绿', buyerPhone: '13800138000' }],
    receiver_name: 'Private Person', note: 'private',
  }] }] })
  const serialized = JSON.stringify(cleaned)
  assert.ok(serialized.includes('雾松绿'))
  assert.ok(serialized.includes('颜色分类'))
  assert.ok(!serialized.includes('13800138000'))
  assert.ok(!serialized.includes('Private Person'))
})

it('keeps every order page when unrelated requests exceed the old 60-response limit', async () => {
  const page = new EventEmitter()
  const stop = observeOrderResponses(page as unknown as Page)
  const emit = (path: string, index: number) => page.emit('response', {
    url: () => `https://fxg.jinritemai.com${path}`,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => ({ data: [{ shop_order_id: String(index).padStart(19, '0') }] }),
  } as unknown as Response)
  for (let i = 0; i < 100; i++) emit('/api/order/searchConfig', i)
  for (let i = 0; i < 75; i++) emit('/api/order/searchlist', i)
  const evidence = await stop()
  assert.equal(evidence.length, 75)
  assert.ok(evidence.every(item => item.path.endsWith('/api/order/searchlist')))
})

it('leaves cancelled responses to full page reconciliation', async () => {
  const page = new EventEmitter()
  const stop = observeOrderResponses(page as unknown as Page)
  page.emit('response', {
    url: () => 'https://fxg.jinritemai.com/api/order/searchlist',
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => { throw new Error('response unavailable') },
  } as unknown as Response)
  assert.deepEqual(await stop(), [])
})

it('fails closed when the order-response capacity is exceeded', async () => {
  const page = new EventEmitter()
  const stop = observeOrderResponses(page as unknown as Page)
  for (let index = 0; index <= 2000; index++) page.emit('response', {
    url: () => 'https://fxg.jinritemai.com/api/order/searchlist',
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => ({ data: [{ shop_order_id: String(index).padStart(19, '0') }] }),
  } as unknown as Response)
  await assert.rejects(stop(), /订单核验响应未能保留/)
})
