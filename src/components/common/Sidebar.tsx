import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import { ChevronDown, ClipboardList, FolderDown, RadioTower } from 'lucide-react'
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
      id: '/',
      name: '订单工作台',
      icon: <ClipboardList className="w-5 h-5" />,
    },
    {
      id: '/order-export',
      name: '订单报表下载',
      icon: <FolderDown className="w-5 h-5" />,
    },
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
  const [liveOpen, setLiveOpen] = useState(isLiveRoute)

  useEffect(() => {
    if (isLiveRoute) setLiveOpen(true)
  }, [isLiveRoute, location.pathname])

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

  return (
    <aside className="w-64 min-w-[256px] bg-background border-r">
      <div className="p-6">
        <h2 className="text-lg font-semibold mb-6">功能列表</h2>
        <nav className="space-y-2">
          {orderTabs.map(tab => renderTab(tab))}
          <button
            type="button"
            aria-expanded={liveOpen}
            aria-controls="live-tools-links"
            onClick={() => setLiveOpen(open => !open)}
            className={cn(
              'flex w-full items-center gap-3 px-4 py-3 text-sm font-medium rounded-lg transition-all text-left',
              isLiveRoute
                ? 'bg-primary/10 text-primary shadow-xs'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <RadioTower className="w-5 h-5" />
            <span className="flex-1">直播工具</span>
            <ChevronDown className={cn('w-4 h-4 transition-transform', liveOpen && 'rotate-180')} />
          </button>
          {liveOpen && (
            <div id="live-tools-links" className="space-y-1">
              {visibleLiveTabs.map(tab => renderTab(tab, true))}
            </div>
          )}
          {utilityTabs.map(tab => renderTab(tab))}
        </nav>
      </div>
    </aside>
  )
}
