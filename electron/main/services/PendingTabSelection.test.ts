import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { Page } from 'playwright'
import { pendingStatusIsSelected } from './DoudianPendingOrderReader'

type Tab = { textContent: string; selected: boolean; activeClass?: boolean }

function pageWithTabs(tabs: Tab[]): Page {
  const group = { querySelectorAll: () => tabNodes }
  const tabNodes = tabs.map(tab => ({
    textContent: tab.textContent,
    getAttribute: (name: string) => name === 'aria-selected' ? String(tab.selected) : 'tab',
    classList: { contains: (name: string) => name === 'auxo-tabs-tab-active' && !!tab.activeClass },
    closest: (): unknown => group,
  }))
  const pending = tabNodes.find(node => /^待发货/.test(node.textContent))
  return { getByRole: () => ({ first: () => ({
    count: async () => pending ? 1 : 0,
    evaluate: async (fn: (node: unknown) => boolean) => fn(pending),
  }) }) } as unknown as Page
}

it('rejects the all-orders tab even when the parent container appears active', async () => {
  assert.equal(await pendingStatusIsSelected(pageWithTabs([
    { textContent: '全部订单', selected: true, activeClass: true },
    { textContent: '待发货 149', selected: false },
  ])), false)
})

it('accepts only one explicitly selected pending tab', async () => {
  assert.equal(await pendingStatusIsSelected(pageWithTabs([
    { textContent: '全部订单', selected: false },
    { textContent: '待发货 149', selected: true, activeClass: true },
    { textContent: '超时未发货及揽收 0', selected: false },
  ])), true)
  assert.equal(await pendingStatusIsSelected(pageWithTabs([
    { textContent: '全部订单', selected: true, activeClass: true },
    { textContent: '待发货 149', selected: true, activeClass: true },
  ])), false)
})
