import test from 'node:test'
import assert from 'node:assert/strict'
import { todayShippedOrders, type VerifiedShipmentLine } from './TodayShippedOrders'
const row: VerifiedShipmentLine = { shopId:'shop',parentId:'parent',childId:'child',packageId:'p1',productId:'product',productName:'衣服',merchantCode:'',color:'黑色',size:'L',childStatus:'已发货',actualShippedAt:'2026-11-14 00:00:00',shippedQuantity:2 }
const now = new Date('2026-11-14T12:00:00+08:00')
test('uses Beijing actual shipment day and deduplicates repeated package lines',()=>{
 const result=todayShippedOrders([row,{...row,actualShippedAt:'2026-11-13T16:00:00Z'},{...row,packageId:'old',actualShippedAt:'2026-11-13 23:59:59'},{...row,packageId:'future',actualShippedAt:'2026-11-15 00:00:00'}],'shop',now)
 assert.equal(result.quantity,2);assert.equal(result.rows.length,1)
})
test('counts actual split quantities without multiplying multi-item packages',()=>{
 const result=todayShippedOrders([{...row,childStatus:'部分发货',shippedQuantity:1},{...row,packageId:'p2',shippedQuantity:2},{...row,childId:'child2',shippedQuantity:3}],'shop',now)
 assert.deepEqual([result.quantity,result.parents,result.children,result.packages],[6,1,2,2])
})
test('rejects conflicts, pending children, unknown quantities and cross-shop data',()=>{
 assert.throws(()=>todayShippedOrders([row,{...row,shippedQuantity:3}],'shop',now),/冲突/)
 assert.throws(()=>todayShippedOrders([{...row,childStatus:'待发货'} as unknown as VerifiedShipmentLine],'shop',now),/状态/)
 assert.throws(()=>todayShippedOrders([{...row,shippedQuantity:0}],'shop',now),/件数/)
 assert.throws(()=>todayShippedOrders([row],'another',now),/身份/)
})
test('rejects invalid dates and accepts shipped orders whose status has progressed',()=>{
 assert.throws(()=>todayShippedOrders([{...row,actualShippedAt:'2026-02-30 00:00:00'}],'shop',now),/时间/)
 assert.throws(()=>todayShippedOrders([{...row,actualShippedAt:'2026-11-14T00:00:00'}],'shop',now),/时区/)
 assert.equal(todayShippedOrders([{...row,childStatus:'已完成'}],'shop',now).quantity,2)
})
