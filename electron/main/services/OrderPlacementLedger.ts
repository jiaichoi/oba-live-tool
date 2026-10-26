import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type PlacementRow = { shop_order_id: string; sku_order_id: string; quantity: number }
export type PlacementSnapshot = { account_id: string; shop_id_verified: string; observed_at: string;
  page_complete: true; rows: PlacementRow[] }
export type PlacementEntry = { shop_order_id: string; sku_order_id: string; source_quantity: number;
  placed_quantity: number; batch_id: string; placed_at: string }
export type PlacementBatch = { id: string; at: string; snapshot_observed_at: string;
  undone_at?: string; entries: PlacementEntry[] }
export type PlacementLedger = { account_id: string; shop_id: string; batches: PlacementBatch[] }

const orderId = /^\d{19}$/
const accountIdPattern = /^[\w-]{1,100}$/
const shopIdPattern = /^\d{5,}$/

export function validatePlacementSnapshot(snapshot: PlacementSnapshot, accountId: string): void {
  if (!accountIdPattern.test(accountId) || snapshot.account_id !== accountId ||
      !shopIdPattern.test(snapshot.shop_id_verified) || snapshot.page_complete !== true ||
      !Number.isFinite(Date.parse(snapshot.observed_at))) throw new Error('店铺、账号或完整待发货快照未核验')
  const ids = new Set<string>()
  for (const row of snapshot.rows) {
    if (!orderId.test(row.shop_order_id) || !orderId.test(row.sku_order_id) || ids.has(row.sku_order_id) ||
        !Number.isSafeInteger(row.quantity) || row.quantity < 1) throw new Error('子订单身份或数量未核验')
    ids.add(row.sku_order_id)
  }
}

export function placementPreview(snapshot: PlacementSnapshot, ledger: PlacementLedger,
  exceptions: Record<string, number>) {
  if (snapshot.account_id !== ledger.account_id || snapshot.shop_id_verified !== ledger.shop_id)
    throw new Error('店铺或账号不一致，已停止确认')
  const alreadyConfirmed = ledger.batches.some(batch => !batch.undone_at &&
    batch.snapshot_observed_at === snapshot.observed_at)
  const currentIds = new Set(snapshot.rows.map(row => row.sku_order_id))
  if (Object.keys(exceptions).some(id => !currentIds.has(id))) throw new Error('例外包含不在本次快照的子订单')
  const rows = snapshot.rows.map(row => {
    const except = exceptions[row.sku_order_id] ?? 0
    if (!Number.isSafeInteger(except) || except < 0 || except > row.quantity)
      throw new Error('例外数量超出子订单数量')
    return { ...row, exception_quantity: except, to_place: alreadyConfirmed ? 0 : row.quantity - except }
  })
  return { rows, to_place: rows.reduce((sum, row) => sum + row.to_place, 0),
    exceptions: rows.reduce((sum, row) => sum + row.exception_quantity, 0), already_confirmed: alreadyConfirmed }
}

export function confirmPlacement(snapshot: PlacementSnapshot, ledger: PlacementLedger,
  exceptions: Record<string, number>, expectedObservedAt: string): { ledger: PlacementLedger; batch: PlacementBatch } {
  if (snapshot.observed_at !== expectedObservedAt) throw new Error('待发货快照已更新，请重新预览')
  const preview = placementPreview(snapshot, ledger, exceptions)
  if (preview.already_confirmed) throw new Error('这次整理快照已经确认，不能重复提交；请先重新整理形成新批次')
  if (!preview.to_place) throw new Error('没有新的待确认数量')
  const id = randomUUID()
  const at = new Date().toISOString()
  const batch: PlacementBatch = { id, at, snapshot_observed_at: snapshot.observed_at,
    entries: preview.rows.filter(row => row.to_place > 0)
    .map(row => ({ shop_order_id: row.shop_order_id, sku_order_id: row.sku_order_id,
      source_quantity: row.quantity, placed_quantity: row.to_place, batch_id: id, placed_at: at })) }
  return { ledger: { ...ledger, batches: [...ledger.batches, batch] }, batch }
}

export function undoPlacement(ledger: PlacementLedger, batchId: string): PlacementLedger {
  const batch = ledger.batches.find(item => item.id === batchId)
  if (!batch || batch.undone_at) throw new Error('批次不存在或已撤销')
  return { ...ledger, batches: ledger.batches.map(item => item.id === batchId
    ? { ...item, undone_at: new Date().toISOString() } : item) }
}

function ledgerPath(root: string, accountId: string, shopId: string): string {
  if (!accountIdPattern.test(accountId) || !shopIdPattern.test(shopId)) throw new Error('账号或店铺标识无效')
  return path.join(root, 'placement-ledgers', `${accountId}_${shopId}.json`)
}

export async function readPlacementLedger(root: string, accountId: string, shopId: string): Promise<PlacementLedger> {
  const source = ledgerPath(root, accountId, shopId)
  try {
    const value = JSON.parse(await readFile(source, 'utf8')) as PlacementLedger
    if (value.account_id !== accountId || value.shop_id !== shopId || !Array.isArray(value.batches))
      throw new Error('本地下单记录与账号或店铺不一致')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { account_id: accountId, shop_id: shopId, batches: [] }
    throw error
  }
}

export async function writePlacementLedger(root: string, ledger: PlacementLedger): Promise<void> {
  const target = ledgerPath(root, ledger.account_id, ledger.shop_id)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(ledger, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, target)
}
