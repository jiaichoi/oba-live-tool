/** Doudian exp_ship_time is a Unix timestamp in seconds. Business days use Beijing time. */
export function beijingDay(value: Date | number): string {
  const milliseconds = value instanceof Date ? value.getTime() : value
  if (!Number.isFinite(milliseconds)) throw new Error('无法确认北京时间')
  return new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function promisedShipDay(value: unknown): string {
  if (!Number.isSafeInteger(value) || Number(value) < 1_577_836_800 || Number(value) > 4_102_444_800)
    throw new Error('官方订单缺少有效承诺发货时间；未生成当天订单')
  return beijingDay(Number(value) * 1000)
}
