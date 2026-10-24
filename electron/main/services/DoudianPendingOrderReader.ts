import type { Page } from 'playwright'

const ORDER_URL = 'https://fxg.jinritemai.com/ffa/morder/order/list'
const MAX_PAGES = 100
const COLORS = ['中花灰', '花紫黑', '黑灰', '深灰', '浅灰', '宝蓝', '黑色', '肤色', '粉色', '大红', '灰色', '橙黄',
  '焦糖', '豆沙', '花芋粉', '花金咖', '花兰紫', '竹青绿', '嫣粉', '铂灰', '月白蓝', '贝壳粉']

export type VisibleOrderLine = {
  parentId: string
  placedAt: string | null
  skuOrderId: string | null
  merchantCode: string | null
  productName: string
  color: string | null
  size: string | null
  quantity: number | null
  aftersaleStatus: string
  orderStatus: string
  promisedShipAt: string | null
  issues: string[]
}

export type CapturedPage = { number: number; parentCount: number; lines: VisibleOrderLine[] }
export type CapturedPartition = {
  key: 'recent_6_months'
  displayedPendingCount: number | null
  pages: CapturedPage[]
  endedAtLastPage: boolean
  emptyStateConfirmed?: boolean
  issues: string[]
}
export type PendingOrderCapture = {
  sourceUrl: string
  visibleShopId: string | null
  startedAt: string
  finishedAt: string
  partitions: CapturedPartition[]
  complete: false
  issues: string[]
}

type RawRow = { className: string; rowKey?: string; cells: string[]; statusTitles?: string[] }

function onlyDigits(value: string): string | null {
  return value.match(/\d{15,}/)?.[0] ?? null
}

/** Parse only merchant and item cells. The shipping-address cell is never read. */
export function parseVisibleRows(rows: RawRow[]): { parentCount: number; lines: VisibleOrderLine[]; issues: string[] } {
  let parentId: string | null = null
  let placedAt: string | null = null
  let parentCount = 0
  const lines: VisibleOrderLine[] = []
  const issues: string[] = []
  for (const row of rows) {
    if (/auxo-table-row-level-0/.test(row.className)) {
      parentId = onlyDigits(row.cells[1] || '')
      placedAt = (row.cells[1] || '').match(/下单时间\s*(\d{4}-\d\d-\d\d\s+\d\d:\d\d:\d\d)/)?.[1] ?? null
      parentCount++
      if (!parentId) issues.push('主订单行缺少订单编号')
      continue
    }
    if (!/auxo-table-row-level-1/.test(row.className)) continue
    const item = row.cells[1] || ''
    const quantityMatch = item.match(/x\s*(\d+)\s*(?:商家编码|带货达人|商品单|$)/i)
    const priceQuantity = (row.cells[2] || '').match(/x\s*(\d+)/i)
    const merchantCode = item.match(/商家编码\s*[:：]\s*([A-Za-z0-9-]+)/)?.[1] ?? null
    // The shop page sometimes concatenates the next quantity digit to its 19-digit item ID.
    // The response cross-check below remains the authority for the exact ID.
    const skuOrderId = item.match(/(?:商品单(?:ID)?|子订单编号|子订单号)\s*[:：]?\s*(\d{19})/)?.[1]
      ?? (row.rowKey && /^\d{15,}$/.test(row.rowKey) ? row.rowKey : null)
    if (!skuOrderId && !quantityMatch && !priceQuantity) continue
    const combined = COLORS.flatMap(first => COLORS.flatMap(second => {
      const match = item.match(new RegExp(`${first}\\s*[+＋]\\s*${second}\\s*[/／]\\s*(3XL|2XL|XL|L|M)(?![A-Za-z])`, 'i'))
      return match ? [{ color: `${first}+${second}`, size: match[1].toUpperCase() }] : []
    }))[0]
    const colorSize = combined ?? COLORS.flatMap(color => {
      const match = item.match(new RegExp(`${color}\\s*(?:（[^）]*）)?\\s*[/／]\\s*(3XL|2XL|XL|L|M)(?![A-Za-z])`, 'i'))
      return match ? [{ color, size: match[1].toUpperCase() }] : []
    })[0]
    const productName = item.split(/x\s*\d+\s*(?:商家编码|带货达人|商品单)/i)[0]?.trim() || ''
    const orderStatus = row.cells[4] || ''
    const aftersaleStatus = row.cells[3] || ''
    const exactPromise = [orderStatus, ...(row.statusTitles || [])].join(' ')
      .match(/(?:承诺发货(?:时间)?|最晚发货(?:时间)?)\s*[:：]?\s*(\d{4}[-/]\d\d[-/]\d\d\s+\d\d:\d\d(?::\d\d)?)/)?.[1]
    const lineIssues: string[] = []
    if (!parentId) lineIssues.push('无法关联主订单')
    if (!skuOrderId) lineIssues.push('页面未见商品子订单编号')
    // Blank merchant codes are kept blank; product ID and name identify these items.
    if (!colorSize) lineIssues.push('无法确认颜色或尺码')
    if (!quantityMatch) lineIssues.push('无法确认商品数量')
    if (quantityMatch && priceQuantity && quantityMatch[1] !== priceQuantity[1]) lineIssues.push('商品行数量与价格列数量不一致')
    if (!/^待发货/.test(orderStatus)) lineIssues.push('商品行状态非明确待发货')
    if (aftersaleStatus && aftersaleStatus !== '-' && !aftersaleStatus.includes('小件运费险')) lineIssues.push('售后状态待核')
    if (!exactPromise) lineIssues.push('页面仅显示发货倒计时，尚未核实绝对承诺发货时间')
    lines.push({ parentId: parentId || '', placedAt, skuOrderId, merchantCode, productName,
      color: colorSize?.color ?? null, size: colorSize?.size ?? null,
      quantity: quantityMatch ? Number(quantityMatch[1]) : null,
      aftersaleStatus, orderStatus, promisedShipAt: exactPromise?.replaceAll('/', '-') ?? null, issues: lineIssues })
  }
  if (parentCount && !lines.length) issues.push('本页有主订单但未读到商品子订单')
  return { parentCount, lines, issues }
}

function currentUrlIsOrderPage(page: Page): boolean {
  try {
    const url = new URL(page.url())
    return `${url.origin}${url.pathname}` === ORDER_URL
  } catch { return false }
}

/** Read only the recent-six-month pending partition requested by the user. */
export async function capturePendingOrderPages(page: Page): Promise<PendingOrderCapture> {
  if (!currentUrlIsOrderPage(page)) throw new Error('当前不是抖店官方订单列表页')
  const result: PendingOrderCapture = { sourceUrl: ORDER_URL, visibleShopId: null, startedAt: new Date().toISOString(),
    finishedAt: '', partitions: [], complete: false, issues: [] }
  result.visibleShopId = await page.locator('body').evaluate(node =>
    node.textContent?.match(/(?:店铺\s*ID|店铺编号)\s*[:：]\s*(\d{5,})/)?.[1] ?? null)
  const partitions = [['recent_6_months', /近\s*6\s*个月订单/]] as const
  for (const [key, label] of partitions) {
    const tab = page.getByRole('tab', { name: label }).first()
    if (await tab.count() !== 1) {
      result.partitions.push({ key, displayedPendingCount: null, pages: [], endedAtLastPage: false,
        issues: [`${key} 时间分区未找到；此分区未采集`] })
      continue
    }
    await tab.click()
    await page.locator('.auxo-spin-spinning').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => undefined)
    const pending = page.getByRole('tab', { name: /待发货/ }).first()
    const partition: CapturedPartition = { key, displayedPendingCount: null,
      pages: [], endedAtLastPage: false, issues: [] }
    if (await pending.count() !== 1) {
      partition.issues.push(`${key} 未显示待发货状态标签；不能把全部订单当成待发货`)
      result.partitions.push(partition)
      continue
    }
    try { await pending.click({ timeout: 5000 }) } catch {
      partition.issues.push(`${key} 待发货状态标签切换时消失；此分区未采集`)
      result.partitions.push(partition)
      continue
    }
    await page.locator('.auxo-spin-spinning').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => undefined)
    const pendingText = await pending.innerText({ timeout: 5000 }).catch(() => '')
    if (!pendingText) {
      partition.issues.push(`${key} 待发货状态标签读取时消失；此分区未采集`)
      result.partitions.push(partition)
      continue
    }
    const displayedPendingCount = Number(pendingText.match(/待发货\s*(\d+)/)?.[1])
    partition.displayedPendingCount = Number.isFinite(displayedPendingCount) ? displayedPendingCount : null
    const pendingSelected = await pending.evaluate(node => node.getAttribute('aria-selected') === 'true' ||
      Boolean(node.closest('.auxo-tabs-tab-active')))
    if (!pendingSelected) partition.issues.push('未证明待发货筛选处于选中状态')
    if (displayedPendingCount === 0) {
      const recentSelected = await tab.evaluate(node => node.getAttribute('aria-selected') === 'true' ||
        Boolean(node.closest('.auxo-tabs-tab-active')))
      const emptyText = await page.locator('tr.auxo-table-placeholder').first().innerText().catch(() => '')
      partition.emptyStateConfirmed = pendingSelected && recentSelected && /暂无数据/.test(emptyText) &&
        await page.locator('tr.auxo-table-row-level-0').count() === 0
      if (!partition.emptyStateConfirmed) partition.issues.push('页面显示0单，但时间分区、筛选或空表状态未共同确认')
      partition.pages.push({ number: 1, parentCount: 0, lines: [] })
      partition.endedAtLastPage = true
      result.partitions.push(partition)
      continue
    }
    // The tab count can update before the order table. Do not parse rows from the
    // previous filter or attempt pagination while the table overlay is still active.
    await page.waitForFunction(expected => {
      const count = document.querySelectorAll('tr.auxo-table-row-level-0').length
      return count > 0 && count <= expected && !document.querySelector('.auxo-spin-spinning')
    }, displayedPendingCount, { timeout: 30000 })
    await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined)
    const seen = new Set<string>()
    let previousFirstParentId = ''
    for (let number = 1; number <= MAX_PAGES; number++) {
      if (!currentUrlIsOrderPage(page)) throw new Error('读取过程中离开了官方订单列表页')
      if (previousFirstParentId) {
        await page.waitForFunction(previous => {
          const first = document.querySelector('tr.auxo-table-row-level-0 td:nth-child(2)')?.textContent || ''
          return Boolean(first.match(/\d{19}/)?.[0]) && !first.includes(previous)
        }, previousFirstParentId, { timeout: 15000 })
      }
      const raw = await page.locator('table tbody tr').evaluateAll(elements => elements.map(row => ({
        className: row.className,
        rowKey: row.getAttribute('data-row-key') || '',
        cells: Array.from(row.querySelectorAll(':scope > td')).slice(0, 5).map(cell => cell.textContent?.replace(/\s+/g, ' ').trim() || ''),
        statusTitles: Array.from(row.querySelectorAll(':scope > td:nth-child(5) [title], :scope > td:nth-child(5) [aria-label]'))
          .map(node => node.getAttribute('title') || node.getAttribute('aria-label') || '').slice(0, 6),
      })))
      const parsed = parseVisibleRows(raw)
      previousFirstParentId = parsed.lines[0]?.parentId || ''
      for (const line of parsed.lines) {
        const key = `${line.parentId}:${line.skuOrderId || line.productName}`
        if (seen.has(key)) partition.issues.push(`商品行跨页重复：${key}`)
        seen.add(key)
      }
      partition.pages.push({ number, parentCount: parsed.parentCount, lines: parsed.lines })
      partition.issues.push(...parsed.issues)
      const observedSoFar = partition.pages.reduce((sum, current) => sum + current.parentCount, 0)
      if (partition.displayedPendingCount !== null && observedSoFar === partition.displayedPendingCount) {
        partition.endedAtLastPage = true
        break
      }
      const next = page.locator('li.auxo-pagination-next').first()
      if (await next.count() === 0) {
        partition.endedAtLastPage = true
        break
      }
      const disabled = await next.evaluate(node => node.classList.contains('auxo-pagination-disabled') ||
        node.getAttribute('aria-disabled') === 'true' || Boolean(node.querySelector('button:disabled')))
      if (disabled) {
        partition.endedAtLastPage = true
        break
      }
      const active = page.locator('li.auxo-pagination-item-active').first()
      const before = await active.innerText().catch(() => String(number))
      await next.locator('button').click()
      await page.waitForFunction(previous => {
        const active = document.querySelector('li.auxo-pagination-item-active')
        return active?.textContent?.trim() !== previous
      }, before, { timeout: 15000 })
    }
    if (!partition.endedAtLastPage) partition.issues.push(`达到 ${MAX_PAGES} 页安全上限，未证明完整`)
    const observedParents = partition.pages.reduce((sum, current) => sum + current.parentCount, 0)
    if (partition.displayedPendingCount !== null && partition.displayedPendingCount !== observedParents)
      partition.issues.push(`主订单数不符：页面 ${partition.displayedPendingCount}，读取 ${observedParents}`)
    result.partitions.push(partition)
  }
  result.finishedAt = new Date().toISOString()
  result.issues = result.partitions.flatMap(partition => partition.issues)
  if (!result.visibleShopId) result.issues.push('订单页面未显示可核验的店铺 ID')
  if (result.partitions.some(part => part.pages.some(current => current.lines.some(line => line.issues.length))))
    result.issues.push('商品行仍有字段待核，不能发布完整尺码矩阵')
  result.issues.push('本次仅核对近6个月待发货；尚未完成读取前后状态一致性复核，不能发布为已验证快照')
  return result
}
