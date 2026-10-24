import type { Page, Response } from 'playwright'

const ALLOWED_FIELD = /(?:^id$|order|sku|product|merchant|custom|seller|shop|quantity|number|\bnum\b|count|status|ship|deliver|promise|expect|deadline|spec|color|size|title)/i
const BLOCKED_FIELD = /buyer|customer|receiver|address|phone|mobile|telephone|contact|identity|idcard|email|cookie|token|secret|password|remark|note/i

export type OrderNetworkEvidence = { path: string; observedAt: string; fields: unknown }

export function sanitizeOrderResponse(value: unknown, depth = 0, inSpecification = false): unknown {
  if (depth > 12 || value === null) return undefined
  if (Array.isArray(value)) {
    const items = value.slice(0, 500).map(item => sanitizeOrderResponse(item, depth + 1, inSpecification)).filter(item => item !== undefined)
    return items.length ? items : undefined
  }
  if (typeof value !== 'object') return undefined
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (BLOCKED_FIELD.test(key)) continue
    if (child && typeof child === 'object') {
      const cleaned = sanitizeOrderResponse(child, depth + 1, inSpecification || /(?:^|_)(?:spec|property|properties|attribute)(?:_|$)/i.test(key))
      if (cleaned !== undefined) output[key] = cleaned
    } else if ((ALLOWED_FIELD.test(key) || (inSpecification && /^(?:name|value|val|key|title)$/i.test(key))) &&
               ['string', 'number', 'boolean'].includes(typeof child)) {
      output[key] = typeof child === 'string' ? child.slice(0, 500) : child
    }
  }
  return Object.keys(output).length ? output : undefined
}

/** Observe JSON responses caused by normal order-page navigation. Never issues an HTTP request. */
export function observeOrderResponses(page: Page) {
  const evidence: OrderNetworkEvidence[] = []
  const jobs: Promise<void>[] = []
  const listener = (response: Response) => {
    if (evidence.length >= 60) return
    let url: URL
    try { url = new URL(response.url()) } catch { return }
    if (url.protocol !== 'https:' || !(url.hostname === 'jinritemai.com' || url.hostname.endsWith('.jinritemai.com'))) return
    if (!response.headers()['content-type']?.includes('json')) return
    jobs.push((async () => {
      try {
        const cleaned = sanitizeOrderResponse(await response.json())
        if (!cleaned) return
        const serialized = JSON.stringify(cleaned)
        if (serialized.length > 300_000 || evidence.length >= 60) return
        evidence.push({ path: `${url.origin}${url.pathname}`, observedAt: new Date().toISOString(), fields: cleaned })
      } catch { /* A response can be cancelled during navigation. */ }
    })())
  }
  page.on('response', listener)
  return async () => {
    page.off('response', listener)
    await Promise.allSettled(jobs)
    return evidence
  }
}
