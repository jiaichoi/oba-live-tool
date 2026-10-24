import { ipcMain } from 'electron'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { orderSyncCoordinator } from '#/services/OrderSyncCoordinator'

export function setupOrderSyncIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.orderSync.getStatus, (_event, accountId: string) =>
    orderSyncCoordinator.getStatus(accountId),
  )
}
