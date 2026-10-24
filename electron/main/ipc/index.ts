import { setupAIChatIpcHandlers } from './aichat'
import { setupAppIpcHandlers } from './app'
import { setupAutoMessageIpcHandlers } from './autoMessage'
import { setupAutoPopUpIpcHandlers } from './autoPopUp'
import { setupBrowserIpcHandlers } from './browser'
import { setupAutoReplyIpcHandlers } from './commentListener'
import { setupLiveControlIpcHandlers } from './connection'
import { setupPinCommentIpcHandler } from './pinComment'
import { setupRedPacketIpcHandlers } from './redPacket'
import { setupUpdateIpcHandlers } from './update'
import { setupOrderExportIpcHandlers } from './orderExport'
import { setupOrderSyncIpcHandlers } from './orderSync'

setupLiveControlIpcHandlers()
setupAIChatIpcHandlers()
setupAutoPopUpIpcHandlers()
setupAutoReplyIpcHandlers()
setupAutoMessageIpcHandlers()
setupBrowserIpcHandlers()
setupAppIpcHandlers()
setupUpdateIpcHandlers()
setupPinCommentIpcHandler()
setupRedPacketIpcHandlers()
setupOrderExportIpcHandlers()
setupOrderSyncIpcHandlers()
