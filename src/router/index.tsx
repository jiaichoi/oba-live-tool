import { createHashRouter, Navigate } from 'react-router'
import AIChat from '@/pages/AIChat'
import AutoMessage from '@/pages/AutoMessage'
import AutoPopUp from '@/pages/AutoPopUp'
import AutoReply from '@/pages/AutoReply'
import AutoReplySettings from '@/pages/AutoReply/AutoReplySettings'
import LiveControl from '@/pages/LiveControl'
import Workbench from '@/pages/Workbench'
import OrderExport from '@/pages/OrderExport'
import RedPacket from '@/pages/RedPacket'
import Settings from '@/pages/SettingsPage'
import App from '../App'

export const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        path: '/',
        element: <Navigate to="/orders/due" replace />,
      },
      {
        path: '/orders/due',
        element: <Workbench path="/due" />,
      },
      {
        path: '/orders/shipped',
        element: <Workbench path="/shipped" />,
      },
      {
        path: '/orders/all',
        element: <Workbench path="/" />,
      },
      {
        path: '/sales/history',
        element: <Workbench path="/sales" />,
      },
      {
        path: '/sales/stock',
        element: <Workbench path="/stock" />,
      },
      {
        path: '/data/history',
        element: <Workbench path="/history" />,
      },
      {
        path: '/data/history-sku',
        element: <Workbench path="/history-sku" />,
      },
      {
        path: '/data/imports',
        element: <Workbench path="/imports" />,
      },
      {
        path: '/data/import',
        element: <Workbench path="/import" />,
      },
      {
        path: '/live-control',
        element: <LiveControl />,
      },
      {
        path: '/order-export',
        element: <OrderExport />,
      },
      {
        path: '/auto-message',
        element: <AutoMessage />,
      },
      {
        path: '/auto-popup',
        element: <AutoPopUp />,
      },
      {
        path: '/settings',
        element: <Settings />,
      },
      {
        path: '/ai-chat',
        element: <AIChat />,
      },
      {
        path: 'auto-reply',
        element: <AutoReply />,
      },
      {
        path: '/auto-reply/settings',
        element: <AutoReplySettings />,
      },
      {
        path: '/red-packet',
        element: <RedPacket />,
      },
    ],
  },
])
