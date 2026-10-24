import assert from 'node:assert/strict'
import { it } from 'node:test'
import { sanitizeOrderResponse } from './DoudianOrderNetworkCapture'

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
