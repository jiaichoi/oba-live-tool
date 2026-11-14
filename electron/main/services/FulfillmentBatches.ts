import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import type { BatchLedger, BatchRow, FulfillmentBatch } from '../../../shared/fulfillmentBatches'
import { beijingDay } from './DoudianDueDay'

const validAccount = (id: string) => /^[\w-]{1,100}$/.test(id)
export function normalizeBatchRows(rows: BatchRow[]): BatchRow[] {
  const unique = new Map<string, BatchRow>()
  for (const value of rows) {
    const row: BatchRow = { shop_order_id: value.shop_order_id, sku_order_id: value.sku_order_id,
      product_id: value.product_id, product_name: value.product_name, merchant_code: value.merchant_code,
      color: value.color, size: value.size, quantity: value.quantity, platform_created_at: value.platform_created_at ?? null }
    if (!/^\d{19}$/.test(row.shop_order_id) || !/^\d{19}$/.test(row.sku_order_id) || !/^\d+$/.test(row.product_id) ||
      !Number.isSafeInteger(row.quantity) || row.quantity < 1 ||
      [row.product_name,row.merchant_code,row.color,row.size].some(v => typeof v !== 'string') ||
      !(row.platform_created_at === null || typeof row.platform_created_at === 'string')) throw new Error('批次商品身份、字段或数量不完整')
    const prior = unique.get(row.sku_order_id)
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error('同一商品子订单存在冲突，未建批次')
    unique.set(row.sku_order_id, row)
  }
  return [...unique.values()].sort((a,b) => a.sku_order_id.localeCompare(b.sku_order_id))
}
export function createBatch(ledger: BatchLedger, shopId: string, input: BatchRow[], at = new Date()) {
  if (!/^\d{5,}$/.test(shopId)) throw new Error('未核实店铺身份')
  const snapshot = normalizeBatchRows(input)
  const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  const assigned = new Map(ledger.batches.filter(b=>b.shop_id===shopId).flatMap(b=>b.rows.map(r=>[r.sku_order_id,r] as const)))
  for (const row of snapshot) {
    const previous=assigned.get(row.sku_order_id)
    if (previous && JSON.stringify(previous)!==JSON.stringify(row)) throw new Error('已归档子订单字段或数量发生变化，请核对原批次；未重复建批次')
  }
  const rows=snapshot.filter(r=>!assigned.has(r.sku_order_id))
  const batch: FulfillmentBatch = { id:randomUUID(),shop_id:shopId,created_at:at.toISOString(),day:beijingDay(at),fingerprint,
    snapshot,rows,previously_assigned:snapshot.length-rows.length }
  return { ledger:{...ledger,batches:[...ledger.batches,batch]},batch,reused:false }
}
export function confirmBatch(ledger: BatchLedger, id: string, kind: 'print'|'erp', erpDay?: string, erpSlot?: string, at = new Date()): BatchLedger {
  const batch=ledger.batches.find(b=>b.id===id)
  if(!batch || !batch.rows.length) throw new Error('批次不存在或无新增商品，无需重复确认')
  if(kind!=='print' && kind!=='erp') throw new Error('确认动作无效')
  if(kind==='print' && batch.printed_at) return ledger
  if(kind==='erp') {
    if(!erpDay || !/^\d{4}-\d{2}-\d{2}$/.test(erpDay) || !Number.isFinite(Date.parse(erpDay)) ||
      new Date(erpDay).toISOString().slice(0,10)!==erpDay || erpDay>beijingDay(at) || !['10:00','16:00'].includes(erpSlot??''))
      throw new Error('请选择有效的 ERP 业务日期和10:00或16:00录入批次')
    if(batch.ordered_at) {
      if(batch.erp_day!==erpDay || batch.erp_slot!==erpSlot) throw new Error('该批已确认其他 ERP 归属，重复操作不会覆盖原记录')
      return ledger
    }
  }
  return {...ledger,batches:ledger.batches.map(b=>b.id!==id?b:kind==='print'?{...b,printed_at:at.toISOString()}:
    {...b,ordered_at:at.toISOString(),erp_day:erpDay,erp_slot:erpSlot as '10:00'|'16:00'})}
}

export class FulfillmentBatchStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private root: string) {}
  private filename(account: string) {
    if(!validAccount(account)) throw new Error('账号标识无效')
    return path.join(this.root,'fulfillment-batches',`${account}.json`)
  }
  async read(account: string): Promise<BatchLedger> {
    try {
      const value=JSON.parse(await readFile(this.filename(account),'utf8')) as BatchLedger
      if(value.version!==1 || value.account_id!==account || !Array.isArray(value.batches)) throw new Error('批次存储格式或账号不匹配')
      for(const batch of value.batches) {
        if(!batch.id || !/^\d{5,}$/.test(batch.shop_id) || beijingDay(new Date(batch.created_at))!==batch.day) throw new Error('批次存储数据损坏')
        normalizeBatchRows(batch.snapshot); normalizeBatchRows(batch.rows)
      }
      return value
    } catch(e) {
      if((e as NodeJS.ErrnoException).code==='ENOENT') return {version:1,account_id:account,batches:[]}
      throw e
    }
  }
  update<T>(account: string, change: (ledger: BatchLedger)=>{ledger:BatchLedger;result:T}):Promise<T> {
    const task=this.queue.then(async()=>{
      const before=await this.read(account); const {ledger,result}=change(before)
      if(ledger!==before) {
        const target=this.filename(account)
        await mkdir(path.dirname(target),{recursive:true,mode:0o700})
        const temp=`${target}.${randomUUID()}.tmp`
        const handle = await open(temp, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify(ledger), 'utf8'); await handle.sync() }
        finally { await handle.close() }
        await rename(temp,target)
      }
      return result
    })
    this.queue=task.catch(()=>undefined)
    return task
  }
}
