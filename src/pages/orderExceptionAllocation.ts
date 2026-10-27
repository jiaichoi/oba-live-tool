export type ExceptionMember = { sku_order_id: string; quantity: number }

export function parseExceptionCount(value: string, sourceQuantity: number): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null
  const count = Number(value)
  return Number.isSafeInteger(count) && count <= sourceQuantity ? count : null
}

// A matrix cell is only a local accounting aggregate. Assign its exception count
// to child orders in a stable order so the existing ledger can keep its SKU keys.
export function allocateExceptionCount(members: ExceptionMember[], count: number): Record<string, number> {
  const sourceQuantity = members.reduce((total, member) => total + member.quantity, 0)
  if (!Number.isSafeInteger(count) || count < 0 || count > sourceQuantity) throw new Error('例外数量超出尺码格数量')
  const next: Record<string, number> = {}
  let remaining = count
  for (const member of [...members].sort((a, b) => a.sku_order_id.localeCompare(b.sku_order_id))) {
    next[member.sku_order_id] = Math.min(member.quantity, remaining)
    remaining -= next[member.sku_order_id]
  }
  return next
}
