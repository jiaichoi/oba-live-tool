import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { summarizeOrderPage } from './DoudianOrderPageProbe'

describe('Doudian order page metadata probe', () => {
  it('recognizes only the known order page and does not treat a visible count as complete orders', () => {
    const result = summarizeOrderPage(
      'https://fxg.jinritemai.com/ffa/morder/order/list?status=pending',
      '近6个月订单 待发货 90 6个月前订单',
    )
    assert.equal(result.ok, true)
    assert.equal(result.visiblePendingMainOrderCount, 90)
    assert.match(result.message, /未同步/)
  })

  it('rejects lookalike hosts and paths', () => {
    for (const url of [
      'https://fxg.jinritemai.com.evil.example/ffa/morder/order/list',
      'https://fxg.jinritemai.com/ffa/morder/order/list/extra',
    ]) {
      assert.equal(summarizeOrderPage(url, '近6个月订单 6个月前订单 待发货 90').ok, false)
    }
  })

  it('recognizes a selected recent range when the older choice is hidden in a dropdown', () => {
    const result = summarizeOrderPage('https://fxg.jinritemai.com/ffa/morder/order/list',
      '近6个月订单 待发货 95')
    assert.equal(result.ok, true)
    assert.equal(result.hasOlderPartition, false)
    assert.match(result.message, /仍缺当前选中状态/)
  })

  it('does not infer a count when the page has conflicting status counters', () => {
    const result = summarizeOrderPage(
      'https://fxg.jinritemai.com/ffa/morder/order/list',
      '近6个月订单 待发货 90 6个月前订单 待发货 2',
    )
    assert.equal(result.visiblePendingMainOrderCount, null)
  })
})
