import { IPC_CHANNELS } from 'shared/ipcChannels'
import windowManager from '#/windowManager'

export type OrderSyncStatus = {
  accountId: string
  phase: 'idle' | 'verifying' | 'awaiting-verification' | 'failed' | 'current'
  message: string
  shopId: string | null
  lastSuccessAt: string | null
  updatedAt: string
}

/**
 * Login and live tasks have separate lifecycles. A login can request order
 * verification, but it cannot publish an order snapshot before the shop and
 * complete report have been checked by an order-specific adapter.
 */
class OrderSyncCoordinator {
  private statuses = new Map<string, OrderSyncStatus>()
  private generations = new Map<string, number>()
  private verifiedShops = new Map<string, { generation: number; shopId: string }>()
  private activeSources = new Map<string, 'live' | 'shop'>()

  getStatus(accountId: string): OrderSyncStatus | null {
    return this.statuses.get(accountId) ?? null
  }

  onAuthenticated(accountId: string, source: 'live' | 'shop' = 'live') {
    const generation = (this.generations.get(accountId) ?? 0) + 1
    this.generations.set(accountId, generation)
    this.verifiedShops.delete(accountId)
    this.activeSources.set(accountId, source)
    this.setStatus(accountId, {
      phase: 'awaiting-verification',
      message: `${source === 'shop' ? '店铺后台' : '直播中控'}已检测到登录；待核验订单页权限、店铺 ID 与完整商品维度报表，尚未同步。`,
      shopId: null,
    })
    return generation
  }

  cancel(accountId: string, source: 'live' | 'shop' = 'live') {
    if (this.activeSources.get(accountId) !== source) return
    this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1)
    this.verifiedShops.delete(accountId)
    this.activeSources.delete(accountId)
    this.setStatus(accountId, {
      phase: 'idle',
      message: '店铺连接已断开；本次会话的待发货订单已清空。',
      shopId: null,
    })
  }

  isCurrent(accountId: string, generation: number) {
    return this.generations.get(accountId) === generation
  }

  bindVerifiedShop(accountId: string, generation: number, shopId: string) {
    if (!this.isCurrent(accountId, generation) || !/^\d+$/.test(shopId)) return false
    this.verifiedShops.set(accountId, { generation, shopId })
    this.setStatus(accountId, {
      phase: 'verifying',
      message: `店铺 ${shopId} 已核验；正在核对订单页面完整性，订单仅在内存中展示。`,
      shopId,
    })
    return true
  }

  fail(accountId: string, generation: number, message: string) {
    if (!this.isCurrent(accountId, generation)) return
    const shopId = this.verifiedShops.get(accountId)?.shopId ?? null
    this.setStatus(accountId, {
      phase: 'failed', message: `${message}；未保存订单。`, shopId,
    })
  }

  markPublished(accountId: string, generation: number, shopId: string, publishedAt: string) {
    const bound = this.verifiedShops.get(accountId)
    if (!this.isCurrent(accountId, generation) || bound?.generation !== generation || bound.shopId !== shopId) {
      return false
    }
    const status: OrderSyncStatus = {
      accountId, phase: 'current', shopId,
      message: `店铺 ${shopId} 待发货订单已读取：${publishedAt}；本机不保存订单内容。`,
      lastSuccessAt: publishedAt, updatedAt: new Date().toISOString(),
    }
    this.statuses.set(accountId, status)
    windowManager.send(IPC_CHANNELS.orderSync.status, status)
    return true
  }

  private setStatus(accountId: string, change: Pick<OrderSyncStatus, 'phase' | 'message' | 'shopId'>) {
    const status: OrderSyncStatus = {
      accountId,
      ...change,
      lastSuccessAt: this.statuses.get(accountId)?.lastSuccessAt ?? null,
      updatedAt: new Date().toISOString(),
    }
    this.statuses.set(accountId, status)
    windowManager.send(IPC_CHANNELS.orderSync.status, status)
  }
}

export const orderSyncCoordinator = new OrderSyncCoordinator()
