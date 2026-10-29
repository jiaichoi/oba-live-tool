import type { Page } from 'playwright'

const ORDER_ORIGIN = 'https://fxg.jinritemai.com'
const ORDER_PATH = '/ffa/morder/order/list'

export type OrderPageProbe = {
  ok: boolean
  message: string
  observedAt: string
  sourceUrl: string | null
  hasRecentPartition: boolean
  hasOlderPartition: boolean
  hasPendingFilter: boolean
  visiblePendingMainOrderCount: number | null
  domHints?: string[]
}

/** Metadata only: this deliberately does not collect order numbers, buyers or tokens. */
export function summarizeOrderPage(urlText: string, visibleText: string): OrderPageProbe {
  const observedAt = new Date().toISOString()
  let url: URL
  try { url = new URL(urlText) } catch {
    return { ok: false, message: '未找到抖店订单页面。', observedAt, sourceUrl: null,
      hasRecentPartition: false, hasOlderPartition: false, hasPendingFilter: false,
      visiblePendingMainOrderCount: null }
  }
  const isOrderPage = url.origin === ORDER_ORIGIN && url.pathname === ORDER_PATH
  const hasRecentPartition = visibleText.includes('近6个月订单') || visibleText.includes('近 6 个月订单')
  const hasOlderPartition = visibleText.includes('6个月前订单') || visibleText.includes('6 个月前订单')
  const hasPendingFilter = visibleText.includes('待发货')
  const countMatches = [...visibleText.matchAll(/待发货\s*\(?\s*(\d+)\s*\)?/g)]
  const counts = [...new Set(countMatches.map(match => Number(match[1])))]
  const visiblePendingMainOrderCount = counts.length === 1 ? counts[0] : null
  // The older partition may be inside a closed dropdown in the new shop layout.
  const ok = isOrderPage && hasRecentPartition && hasPendingFilter
  return { ok, observedAt, sourceUrl: isOrderPage ? `${url.origin}${url.pathname}` : null,
    hasRecentPartition, hasOlderPartition, hasPendingFilter, visiblePendingMainOrderCount,
    message: ok
      ? '已见订单页面与近6个月文字；仍缺当前选中状态、店铺 ID、订单响应结构、完整分页及商品子订单，未同步。'
      : '订单页面或时间分区未核实，未同步。' }
}

/** Reads an already open page; no navigation, clicks, requests or order persistence. */
export async function probeOpenOrderPages(pages: Page[]): Promise<OrderPageProbe> {
  for (const page of pages) {
    if (page.isClosed()) continue
    let url: URL
    try { url = new URL(page.url()) } catch { continue }
    if (url.origin !== ORDER_ORIGIN || url.pathname !== ORDER_PATH) continue
    try {
      const visibleText = await page.locator('body').innerText({ timeout: 5000 })
      const result = summarizeOrderPage(page.url(), visibleText)
      result.domHints = await page.evaluate(() => {
        const compact = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 110)
        const safe = (value: string) => value.replace(/\d{5,}/g, '[编号]').replace(/1\d{10}/g, '[手机号]')
        const hints: string[] = []
        for (const table of Array.from(document.querySelectorAll('table')).slice(0, 3)) {
          const headers = Array.from(table.querySelectorAll('th')).map(node => safe(compact(node.textContent))).slice(0, 30)
          hints.push(`表格: ${headers.join(' | ')}；可见行 ${table.querySelectorAll('tbody tr').length}`)
          for (const [index, row] of Array.from(table.querySelectorAll('tbody tr')).slice(0, 2).entries()) {
            const cells = Array.from(row.querySelectorAll(':scope > td')).slice(0, 5)
            hints.push(`样本行 ${index + 1}: ${cells.map((cell, cellIndex) =>
              `${cellIndex}:${safe(compact(cell.textContent).slice(0, 260))}`).join(' || ')}`)
            hints.push(`样本行结构 ${index + 1}: ${row.className || '-'}；列数 ${row.querySelectorAll(':scope > td').length}`)
          }
        }
        for (const node of Array.from(document.querySelectorAll('[class*="pagination"], [aria-label*="页"], [title*="页"]')).slice(-18)) {
          hints.push(`翻页候选 ${node.tagName.toLowerCase()}.${typeof node.className === 'string' ? node.className.split(/\s+/).slice(0, 2).join('.') : ''}: ${safe(compact(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title')))}`)
        }
        for (const node of Array.from(document.querySelectorAll('button,[role="button"],a,[role="tab"]'))) {
          const label = safe(compact(node.textContent || node.getAttribute('aria-label')))
          if (/近.?6个月|6个月前|待发货|下一页|上一页|每页|确定|查询|重置/.test(label)) {
            hints.push(`${node.tagName.toLowerCase()}${node.getAttribute('role') ? `[${node.getAttribute('role')}]` : ''}: ${label}`)
          }
          if (hints.length >= 35) break
        }
        const labels = Array.from(document.querySelectorAll('body *'))
          .filter(node => node.children.length === 0 && /主订单编号|子订单编号|商家编码|承诺发货|商品数量|订单状态/.test(compact(node.textContent)))
          .slice(0, 8)
        for (const label of labels) {
          const chain: string[] = []
          let node: Element | null = label
          for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
            chain.push(`${node.tagName.toLowerCase()}${node.className && typeof node.className === 'string' ? '.' + node.className.split(/\s+/).slice(0, 2).join('.') : ''}`)
          }
          hints.push(`字段 ${safe(compact(label.textContent))}: ${chain.join(' > ')}`)
        }
        return hints.slice(0, 45)
      })
      return result
    } catch { break }
  }
  return summarizeOrderPage('', '')
}
