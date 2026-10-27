export type MatrixRow = { product_id: string; merchant_code: string; product_name: string;
  color: string; size: string; variant_role?: 'color' | 'raw_spec'; quantity: number }

function sizeOrder(value: string): [number, number | string] {
  const size = value.toUpperCase()
  const known: Record<string, number> = { XS: 0, S: 1, M: 2, L: 3, XL: 4 }
  if (size in known) return [0, known[size]]
  const multiple = size.match(/^(\d{1,2})XL$/)
  if (multiple) return [0, 3 + Number(multiple[1])]
  const numeric = size.match(/^(\d{2,3})(?:CM|厘米|码)$/)
  if (numeric) return [1, Number(numeric[1])]
  return [2, size]
}

export function compareSizes(a: string, b: string): number {
  const left = sizeOrder(a)
  const right = sizeOrder(b)
  return left[0] - right[0] || (typeof left[1] === 'number' && typeof right[1] === 'number'
    ? left[1] - right[1] : String(left[1]).localeCompare(String(right[1]), 'zh-CN'))
}

export function matrixRowKey(row: MatrixRow): string {
  return JSON.stringify([row.product_id, row.merchant_code, row.product_name, row.color, row.variant_role])
}

export function groupMatrixRows<T extends MatrixRow>(rows: T[]) {
  const values = new Map<string, { key: string; row: T; sizes: Record<string, number>; children: number; quantity: number }>()
  for (const row of rows) {
    const key = matrixRowKey(row)
    const group = values.get(key) ?? { key, row, sizes: {}, children: 0, quantity: 0 }
    group.sizes[row.size] = (group.sizes[row.size] ?? 0) + row.quantity
    group.children += 1
    group.quantity += row.quantity
    values.set(key, group)
  }
  return [...values.values()].sort((a, b) => (a.row.merchant_code || a.row.product_name)
    .localeCompare(b.row.merchant_code || b.row.product_name, 'zh-CN'))
}
