import { beijingDay } from './DoudianDueDay'

/** Adapter contract: quantity and time must come from an actual platform shipment,
 * never from purchase quantity, printing, placement, or the parent status alone. */
export type VerifiedShipmentLine = {
  shopId: string; parentId: string; childId: string; packageId: string
  productId: string; productName: string; merchantCode: string; color: string; size: string
  childStatus: '已发货' | '部分发货' | '已收货' | '已完成'
  actualShippedAt: string; shippedQuantity: number
}

function shipmentInstant(value: string): Date {
  // Bare platform timestamps are Beijing wall-clock time; ISO requires an explicit zone.
  const raw = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + '+08:00' : value
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw))
    throw new Error('实际发货时间缺失、格式不明或未指定时区')
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime())) throw new Error('实际发货时间无效')
  const parts = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)!
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number)
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59)
    throw new Error('实际发货时间无效')
  return date
}

export function todayShippedOrders(lines: VerifiedShipmentLine[], shopId: string, now = new Date()) {
  if (!shopId) throw new Error('未核实店铺身份')
  const day = beijingDay(now)
  const seen = new Map<string, VerifiedShipmentLine>()
  for (const line of lines) {
    if (line.shopId !== shopId || !line.parentId || !line.childId || !line.packageId || !line.productId)
      throw new Error('店铺、商品或包裹身份未核实')
    if (!['已发货', '部分发货', '已收货', '已完成'].includes(line.childStatus))
      throw new Error('商品行不是已核实的发货状态')
    if (!Number.isSafeInteger(line.shippedQuantity) || line.shippedQuantity < 1)
      throw new Error('包裹实际发出件数未核实')
    const normalized = { ...line, actualShippedAt: shipmentInstant(line.actualShippedAt).toISOString() }
    const key = JSON.stringify([line.shopId, line.packageId, line.childId])
    const previous = seen.get(key)
    if (previous && Object.keys(normalized).some(key => normalized[key as keyof VerifiedShipmentLine] !== previous[key as keyof VerifiedShipmentLine]))
      throw new Error('同一包裹商品行存在数量、状态或字段冲突；请重新读取')
    seen.set(key, normalized)
  }
  const rows = [...seen.values()].filter(row => beijingDay(new Date(row.actualShippedAt)) === day)
    .sort((a, b) => a.actualShippedAt.localeCompare(b.actualShippedAt) || a.childId.localeCompare(b.childId))
  return { day, rows, parents: new Set(rows.map(r => r.parentId)).size,
    children: new Set(rows.map(r => r.childId)).size, packages: new Set(rows.map(r => r.packageId)).size,
    quantity: rows.reduce((sum, row) => sum + row.shippedQuantity, 0) }
}
