import { createHashRouter, Navigate } from 'react-router'
import AIChat from '@/pages/AIChat'
import AutoMessage from '@/pages/AutoMessage'
import AutoPopUp from '@/pages/AutoPopUp'
import AutoReply from '@/pages/AutoReply'
import AutoReplySettings from '@/pages/AutoReply/AutoReplySettings'
import LiveControl from '@/pages/LiveControl'
import Workbench from '@/pages/Workbench'
import AutoOrders from '@/pages/AutoOrders'
import ShopConnect from '@/pages/ShopConnect'
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
        element: <Navigate to="/orders/all" replace />,
      },
      {
        path: '/orders/due',
        element: <AutoOrders />,
      },
      {
        path: '/orders/connect',
        element: <ShopConnect />,
      },
      {
        path: '/orders/shipped',
        element: <Navigate to="/orders/due" replace />,
      },
      {
        path: '/orders/all',
        element: <AutoOrders mode="all" />,
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
        element: <Navigate to="/orders/due" replace />,
      },
      {
        path: '/data/history-sku',
        element: <Navigate to="/orders/due" replace />,
      },
      {
        path: '/data/imports',
        element: <Navigate to="/orders/due" replace />,
      },
      {
        path: '/data/import',
        element: <Navigate to="/orders/due" replace />,
      },
      {
        path: '/live-control',
        element: <LiveControl />,
      },
      {
        path: '/order-export',
        element: <Navigate to="/orders/due" replace />,
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
