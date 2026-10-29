import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beijingDay, promisedShipDay } from './DoudianDueDay'

test('uses Beijing midnight for the business date', () => {
  assert.equal(beijingDay(new Date('2026-10-28T15:59:59Z')), '2026-10-28')
  assert.equal(beijingDay(new Date('2026-10-28T16:00:00Z')), '2026-10-29')
  assert.equal(promisedShipDay(Date.parse('2026-10-28T16:00:00Z') / 1000), '2026-10-29')
})

test('rejects missing or ambiguous promise timestamps', () => {
  for (const value of [null, '', '1793203200', 0, NaN, 1793203200000])
    assert.throws(() => promisedShipDay(value), /承诺发货时间/)
})
