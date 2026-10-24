import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import { ChartColumn, ChevronDown, ClipboardList, Database, FolderDown, History, List, PackageCheck, RadioTower, Upload } from 'lucide-react'
import { abilities, autoReplyPlatforms } from '@/abilities'
import { useCurrentAutoMessage } from '@/hooks/useAutoMessage'
import { useCurrentAutoPopUp } from '@/hooks/useAutoPopUp'
import { useAutoReply } from '@/hooks/useAutoReply'
import { useCurrentLiveControl } from '@/hooks/useLiveControl'
import { cn } from '@/lib/utils'
import {
  CarbonBlockStorage,
  CarbonChat,
  CarbonContentDeliveryNetwork,
  CarbonGift,
  CarbonIbmEventAutomation,
  CarbonIbmWatsonTextToSpeech,
  CarbonSettings,
} from '../icons/carbon'

interface SidebarTab {
  id: string
  name: string
  isRunning?: boolean
  icon: React.ReactNode
  platform?: LiveControlPlatform[]
}

export default function Sidebar() {
  const isAutoMessageRunning = useCurrentAutoMessage(context => context.isRunning)
  const isAutoPopupRunning = useCurrentAutoPopUp(context => context.isRunning)
  const { isRunning: isAutoReplyRunning } = useAutoReply()
  const platform = useCurrentLiveControl(context => context.platform)
  const location = useLocation()

  const orderTabs: SidebarTab[] = [
    {
      id: '/orders/due',
      name: '全部待发货',
      icon: <ClipboardList className="w-5 h-5" />,
    },
    {
      id: '/orders/shipped',
      name: '当日已发货',
      icon: <PackageCheck className="w-5 h-5" />,
    },
    {
      id: '/orders/all',
      name: '全部订单',
      icon: <List className="w-5 h-5" />,
    },
  ]
  const salesTabs: SidebarTab[] = [
    { id: '/sales/history', name: '销量历史', icon: <ChartColumn className="w-5 h-5" /> },
    { id: '/sales/stock', name: '平台库存快照', icon: <Database className="w-5 h-5" /> },
  ]
  const dataTabs: SidebarTab[] = [
    { id: '/data/history', name: '历史订单', icon: <History className="w-5 h-5" /> },
    { id: '/data/history-sku', name: '历史 SKU 子订单', icon: <List className="w-5 h-5" /> },
    { id: '/data/imports', name: '导入记录', icon: <ClipboardList className="w-5 h-5" /> },
    { id: '/data/import', name: '导入报表', icon: <Upload className="w-5 h-5" /> },
  ]
  const liveTabs: SidebarTab[] = [
    {
      id: '/live-control',
      name: '打开中控台',
      icon: <CarbonContentDeliveryNetwork className="w-5 h-5" />,
    },
    {
      id: '/auto-message',
      name: '自动发言',
      isRunning: isAutoMessageRunning,
      icon: <CarbonChat className="w-5 h-5" />,
    },
    {
      id: '/auto-popup',
      name: '自动弹窗',
      isRunning: isAutoPopupRunning,
      icon: <CarbonBlockStorage className="w-5 h-5" />,
    },
    {
      id: '/auto-reply',
      name: '自动回复',
      isRunning: isAutoReplyRunning,
      icon: <CarbonIbmEventAutomation className="w-5 h-5" />,
      platform: autoReplyPlatforms,
    },
    {
      id: '/red-packet',
      name: '一键发红包',
      icon: <CarbonGift className="w-5 h-5" />,
      platform: ['douyin', 'buyin'],
    },
  ]
  const utilityTabs: SidebarTab[] = [
    {
      id: '/ai-chat',
      name: 'AI 助手',
      icon: <CarbonIbmWatsonTextToSpeech className="w-5 h-5" />,
    },
    {
      id: '/settings',
      name: '应用设置',
      icon: <CarbonSettings className="w-5 h-5" />,
    },
  ]

  const visibleLiveTabs = liveTabs.filter(tab => {
    if (tab.platform) {
      return tab.platform.includes(platform)
    }
    return true
  })
  const isLiveRoute = liveTabs.some(tab =>
    location.pathname === tab.id || location.pathname.startsWith(`${tab.id}/`),
  )
  const isOrderRoute = location.pathname.startsWith('/orders/')
  const isSalesRoute = location.pathname.startsWith('/sales/')
  const isDataRoute = location.pathname.startsWith('/data/')
  const [orderOpen, setOrderOpen] = useState(isOrderRoute)
  const [salesOpen, setSalesOpen] = useState(isSalesRoute)
  const [dataOpen, setDataOpen] = useState(isDataRoute)
  const [liveOpen, setLiveOpen] = useState(isLiveRoute)

  useEffect(() => {
    if (isOrderRoute) setOrderOpen(true)
    if (isSalesRoute) setSalesOpen(true)
    if (isDataRoute) setDataOpen(true)
    if (isLiveRoute) setLiveOpen(true)
  }, [isOrderRoute, isSalesRoute, isDataRoute, isLiveRoute, location.pathname])

  const renderTab = (tab: SidebarTab, nested = false) => (
    <NavLink
      key={tab.id}
      to={tab.id}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-lg transition-all relative',
          nested && 'ml-5',
          isActive
            ? 'bg-primary/10 text-primary shadow-xs'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )
      }
    >
      {tab.icon}
      {tab.name}
      {tab.isRunning && (
        <span className="absolute right-3 w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
      )}
    </NavLink>
  )

  const renderGroup = (
    id: string, name: string, icon: React.ReactNode, tabs: SidebarTab[],
    open: boolean, setOpen: React.Dispatch<React.SetStateAction<boolean>>, active: boolean,
  ) => (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(value => !value)}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-3 text-sm font-medium rounded-lg transition-all text-left',
          active ? 'bg-primary/10 text-primary shadow-xs' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        {icon}
        <span className="flex-1">{name}</span>
        <ChevronDown className={cn('w-4 h-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div id={id} className="space-y-1">{tabs.map(tab => renderTab(tab, true))}</div>}
    </div>
  )

  return (
    <aside className="w-64 min-w-[256px] h-full overflow-y-auto bg-background border-r">
      <div className="p-6">
        <h2 className="text-lg font-semibold mb-6">功能列表</h2>
        <nav className="space-y-2">
          {renderGroup('order-fulfillment-links', '订单履约', <ClipboardList className="w-5 h-5" />, orderTabs, orderOpen, setOrderOpen, isOrderRoute)}
          {renderTab({ id: '/order-export', name: '订单报表下载', icon: <FolderDown className="w-5 h-5" /> })}
          {renderGroup('sales-links', '销量分析', <ChartColumn className="w-5 h-5" />, salesTabs, salesOpen, setSalesOpen, isSalesRoute)}
          {renderGroup('data-links', '数据管理', <Database className="w-5 h-5" />, dataTabs, dataOpen, setDataOpen, isDataRoute)}
          {renderGroup('live-tools-links', '直播工具', <RadioTower className="w-5 h-5" />, visibleLiveTabs, liveOpen, setLiveOpen, isLiveRoute)}
          {utilityTabs.map(tab => renderTab(tab))}
        </nav>
      </div>
    </aside>
  )
}
