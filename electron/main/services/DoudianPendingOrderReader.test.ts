import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { officialVariantMatchesVisibleLine, parseStructuredVariant, parseVisibleRows, pendingCaptureFingerprint, type PendingOrderCapture } from './DoudianPendingOrderReader'

describe('visible Doudian parent and merchandise rows', () => {
  it('parses the aurora table parent and item rows', () => {
    const result = parseVisibleRows([
      { className: 'aurora-table-measure-row', cells: ['', '商品信息'] },
      { className: 'aurora-table-row aurora-table-row-level-0', cells: ['', '订单编号 1234567890123456789 下单时间 2026-10-29 09:20:00'] },
      { className: 'aurora-table-row aurora-table-row-level-1', cells: ['',
        '羊毛裤【女款】黑色/L x1 商家编码:54628BNYB 商品单ID:2234567890123456789',
        '¥139.00 x1', '-', '待发货 承诺发货时间 2026-10-30 18:00:00'] },
    ])
    assert.equal(result.parentCount, 1)
    assert.equal(result.lines.length, 1)
    assert.equal(result.lines[0].skuOrderId, '2234567890123456789')
    assert.equal(result.lines[0].quantity, 1)
  })
  it('ignores a live shipping countdown but detects quantity and status changes', () => {
    const capture: PendingOrderCapture = { sourceUrl: '', visibleShopId: null, startedAt: '', finishedAt: '',
      complete: false, issues: [], partitions: [{ key: 'recent_6_months', displayedPendingCount: 1,
        endedAtLastPage: true, issues: [], pages: [{ number: 1, parentCount: 1, lines: [{
          parentId: '1234567890123456789', skuOrderId: '2234567890123456789', productName: '测试商品',
          placedAt: null, merchantCode: null, color: '黑色', size: 'L', variantRole: 'color',
          quantity: 1, aftersaleStatus: '-', orderStatus: '待发货承诺发货40小时29分钟13秒内发货及揽收',
          promisedShipAt: null, issues: [],
        }] }] }] }
    const first = pendingCaptureFingerprint(capture)
    const line = capture.partitions[0].pages[0].lines[0]
    line.orderStatus = '待发货承诺发货40小时28分钟41秒内发货及揽收'
    assert.equal(pendingCaptureFingerprint(capture), first)
    line.quantity = 2
    assert.notEqual(pendingCaptureFingerprint(capture), first)
    line.quantity = 1
    line.orderStatus = '已发货'
    assert.notEqual(pendingCaptureFingerprint(capture), first)
  })
  it('reads structured SKU property names and values without a colour list', () => {
    assert.deepEqual(parseStructuredVariant({ sku_properties: [
      { name: '颜色分类', value: '月影蓝' }, { name: '尺码', value: '加大号' },
    ] }), { color: '月影蓝', size: '加大号', role: 'color' })
    assert.deepEqual(parseStructuredVariant({ color: '雾松绿', size: '110cm' }),
      { color: '雾松绿', size: '110cm', role: 'color' })
    assert.deepEqual(parseStructuredVariant({ sku_spec: [
      { name: '颜色分类', value: '【男款】黑灰（1件装）' },
      { name: '尺码大小', value: 'XL(110-130斤)' },
    ] }), { color: '【男款】黑灰（1件装）', size: 'XL', role: 'color' })
    assert.deepEqual(parseStructuredVariant({ sku_spec: '雾松绿/5XL' }),
      { color: '雾松绿', size: '5XL', role: 'color' })
    assert.deepEqual(parseStructuredVariant({ sku_spec: '女-鸿运套装/2XL' }),
      { color: '女-鸿运套装', size: '2XL', role: 'raw_spec' })
    assert.equal(parseStructuredVariant({ sku_properties: [{ name: '花色', value: '01' }] }), null)
  })
  it('matches an official full SKU when the page omits a style prefix or cannot split the colour', () => {
    const item = { sku_spec: [
      { name: '颜色分类', value: '【男款】黑灰（1件装）' },
      { name: '尺码大小', value: 'XL(110-130斤)' },
    ] }
    const variant = parseStructuredVariant(item)!
    assert.equal(officialVariantMatchesVisibleLine(item, {
      productName: '保暖棉裤【男款】黑灰（1件装）/XL(110-130斤)', color: null, size: null,
    }, variant), true)
    assert.equal(officialVariantMatchesVisibleLine(item, {
      productName: '保暖棉裤【男款】黑灰（1件装）/2XL(130-155斤)', color: null, size: null,
    }, variant), false)
    assert.equal(officialVariantMatchesVisibleLine(item, {
      productName: '保暖棉裤【男款】黑灰（1件装）/XL(110-130斤)', color: '黑灰', size: '2XL',
    }, variant), false)
  })
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

  it('reads an explicit new colour and 4XL without guessing from the title', () => {
    const result = parseVisibleRows([
      { className: 'auxo-table-row-level-0', cells: ['', '订单编号 1234567890123456789'] },
      { className: 'auxo-table-row-level-1', cells: ['',
        '稻草人保暖裤【单裤】花驼灰/4XL(男180-200斤) x1 商品单 2234567890123456789',
        '¥99 x1', '-', '待发货'] },
    ])
    assert.equal(result.lines[0].color, '花驼灰')
    assert.equal(result.lines[0].size, '4XL')
    assert.equal(result.lines[0].quantity, 1)
  })

  it('does not treat an unmarked title fragment as a new colour', () => {
    const result = parseVisibleRows([
      { className: 'auxo-table-row-level-0', cells: ['', '订单编号 1234567890123456789'] },
      { className: 'auxo-table-row-level-1', cells: ['',
        '商品标题花驼灰/4XL x1 商品单 2234567890123456789', '¥99 x1', '-', '待发货'] },
    ])
    assert.equal(result.lines[0].color, null)
    assert.ok(result.lines[0].issues.includes('无法确认颜色或尺码'))
  })

  it('accepts a new standalone colour and size without configuring either value', () => {
    const result = parseVisibleRows([
      { className: 'auxo-table-row-level-0', cells: ['', '订单编号 1234567890123456789'] },
      { className: 'auxo-table-row-level-1', cells: ['',
        '新款外套【加绒】雾松绿/5XL x2 商家编码:NEW_CODE-82 商品单 2234567890123456789',
        '¥89 x2', '-', '待发货'] },
    ])
    assert.equal(result.lines[0].merchantCode, 'NEW_CODE-82')
    assert.equal(result.lines[0].color, '雾松绿')
    assert.equal(result.lines[0].size, '5XL')
    assert.equal(result.lines[0].quantity, 2)
  })

  it('uses explicit field labels for unfamiliar values and leaves numeric ambiguity for review', () => {
    const rows = [
      { className: 'auxo-table-row-level-0', cells: ['', '订单编号 1234567890123456789'] },
      { className: 'auxo-table-row-level-1', cells: ['',
        '童装 颜色:月影蓝 尺码:加大号 x1 商品单 2234567890123456789', '¥89 x1', '-', '待发货'] },
      { className: 'auxo-table-row-level-1', cells: ['',
        '童装【新款】02/42 x1 商品单 3234567890123456789', '¥89 x1', '-', '待发货'] },
    ]
    const result = parseVisibleRows(rows)
    assert.equal(result.lines[0].color, '月影蓝')
    assert.equal(result.lines[0].size, '加大号')
    assert.equal(result.lines[1].color, null)
    assert.ok(result.lines[1].issues.includes('无法确认颜色或尺码'))
    assert.ok(result.lines[1].productName.includes('02/42'))
  })

  it('keeps an absent merchant code blank and preserves a new two-colour variant', () => {
    const result = parseVisibleRows([
      { className: 'auxo-table-row-level-0', cells: ['', '订单编号 1234567890123456789'] },
      { className: 'auxo-table-row-level-1', cells: ['',
        '新品【双件】雾松绿+月影蓝/110cm x1 商品单 2234567890123456789',
        '¥89 x1', '-', '待发货'] },
    ])
    assert.equal(result.lines[0].merchantCode, null)
    assert.equal(result.lines[0].color, '雾松绿+月影蓝')
    assert.equal(result.lines[0].size, '110cm')
    assert.equal(result.lines[0].quantity, 1)
  })

  it('uses a numbered style boundary for an unfamiliar colour joined to a title', () => {
    const result = parseVisibleRows([
      { className: 'auxo-table-row-level-0', cells: ['', '订单编号 1234567890123456789'] },
      { className: 'auxo-table-row-level-1', cells: ['',
        '男款正肩短袖T-09巧克力色/3XL(160-180斤) x1 商品单 2234567890123456789',
        '¥89 x1', '-', '待发货'] },
    ])
    assert.equal(result.lines[0].color, '巧克力色')
    assert.equal(result.lines[0].size, '3XL')
  })

  it('keeps an untyped style specification intact without calling it a colour', () => {
    const result = parseVisibleRows([
      { className: 'auxo-table-row-level-0', cells: ['', '订单编号 1234567890123456789'] },
      { className: 'auxo-table-row-level-1', cells: ['',
        '保暖情侣套装-156女-鸿运套装/2XL(140-160斤) x1 商品单 2234567890123456789',
        '¥89 x1', '-', '待发货'] },
    ])
    assert.equal(result.lines[0].color, '女-鸿运套装')
    assert.equal(result.lines[0].size, '2XL')
    assert.equal(result.lines[0].variantRole, 'raw_spec')
    assert.equal(result.lines[0].quantity, 1)
  })
})
