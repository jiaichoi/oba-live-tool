import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseVisibleRows } from './DoudianPendingOrderReader'

describe('visible Doudian parent and merchandise rows', () => {
  it('keeps parent and SKU counts distinct and reads only order columns', () => {
    const result = parseVisibleRows([
      { className: 'auxo-table-row-level-0', cells: ['', '订单编号 1234567890123456789 下单时间 2026-10-24 12:36:19'] },
      { className: 'auxo-table-row-level-1', cells: ['',
        '羊毛裤【男士】深灰/2XL x1 商家编码:54629BNYA 商品单 2234567890123456789',
        '¥139.00 x1', '-小件运费险', '待发货 承诺发货时间 2026-10-25 18:00:00'] },
    ])
    assert.equal(result.parentCount, 1)
    assert.equal(result.lines.length, 1)
    assert.equal(result.lines[0].parentId, '1234567890123456789')
    assert.equal(result.lines[0].skuOrderId, '2234567890123456789')
    assert.equal(result.lines[0].merchantCode, '54629BNYA')
    assert.equal(result.lines[0].color, '深灰')
    assert.equal(result.lines[0].size, '2XL')
    assert.equal(result.lines[0].quantity, 1)
    assert.equal(result.lines[0].promisedShipAt, '2026-10-25 18:00:00')
    assert.deepEqual(result.lines[0].issues, [])
  })

  it('flags unavailable SKU ID and deadline instead of guessing values', () => {
    const result = parseVisibleRows([
      { className: 'auxo-table-row-level-0', cells: ['', '订单编号 1234567890123456789'] },
      { className: 'auxo-table-row-level-1', cells: ['', '羊毛裤 黑色/L x2 商家编码:54628BNYB', '¥139 x2', '-', '待发货 10小时内发货'] },
    ])
    assert.equal(result.lines[0].skuOrderId, null)
    assert.equal(result.lines[0].promisedShipAt, null)
    assert.ok(result.lines[0].issues.some(issue => issue.includes('商品子订单编号')))
    assert.ok(result.lines[0].issues.some(issue => issue.includes('绝对承诺发货时间')))
  })

  it('keeps two listed colors in one purchased SKU without doubling quantity', () => {
    const result = parseVisibleRows([
      { className: 'auxo-table-row-level-0', cells: ['', '订单编号 1234567890123456789'] },
      { className: 'auxo-table-row-level-1', cells: ['',
        '女士保暖背心内搭肤色+黑色/M(100-120斤) x1 商品单 2234567890123456789',
        '¥49 x1', '-', '待发货'] },
    ])
    assert.equal(result.lines.length, 1)
    assert.equal(result.lines[0].color, '肤色+黑色')
    assert.equal(result.lines[0].size, 'M')
    assert.equal(result.lines[0].quantity, 1)
  })
})
