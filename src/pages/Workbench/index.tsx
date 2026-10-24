import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { useAccounts } from '@/hooks/useAccounts'

function outerRoute(path: string) {
  if (path === '/due') return '/orders/due'
  if (path === '/shipped') return '/orders/shipped'
  if (path === '/' || path === '/order') return '/orders/all'
  if (path === '/sales' || path === '/sales-import' || path === '/sales-refund-import') return '/sales/history'
  if (path === '/stock') return '/sales/stock'
  if (path === '/history' || path === '/history-stage') return '/data/history'
  if (path === '/history-sku') return '/data/history-sku'
  if (path === '/imports' || path.startsWith('/imports/')) return '/data/imports'
  if (path === '/import' || path === '/forget-archive') return '/data/import'
  return null
}

/** The native view keeps local forms, filters and order details on their own origin. */
export default function Workbench({ path }: { path: string }) {
  const target = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const preservePath = (location.state as { embeddedPath?: string } | null)?.embeddedPath
  const accountId = useAccounts(state => state.currentAccountId)
  const [syncMessage, setSyncMessage] = useState('尚未连接店铺；本页显示已导入快照。')

  useEffect(() => {
    let active = true
    void window.ipcRenderer.invoke(IPC_CHANNELS.orderSync.getStatus, accountId).then(status => {
      if (active) setSyncMessage(status?.message ?? '尚未连接店铺；本页显示已导入快照。')
    })
    const remove = window.ipcRenderer.on(IPC_CHANNELS.orderSync.status, status => {
      if (status.accountId === accountId) setSyncMessage(status.message)
    })
    return () => { active = false; remove() }
  }, [accountId])

  useEffect(() => {
    const remove = window.ipcRenderer.on(IPC_CHANNELS.workbench.navigated, ({ path: visited }) => {
      const route = outerRoute(visited)
      if (route && route !== location.pathname) {
        navigate(route, { state: { embeddedPath: visited } })
      }
    })
    return remove
  }, [location.pathname, navigate])

  useEffect(() => {
    const element = target.current
    if (!element) return
    const show = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      void window.ipcRenderer.invoke(IPC_CHANNELS.workbench.show, {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
        path, requestKey: location.key, preservePath,
      })
    }
    const observer = new ResizeObserver(show)
    observer.observe(element)
    window.addEventListener('resize', show)
    show()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', show)
      void window.ipcRenderer.invoke(IPC_CHANNELS.workbench.hide)
    }
  }, [path, location.key, preservePath])

  return <div className="flex h-full flex-col gap-2">
    {path === '/due' && <div role="status" className="rounded-lg border bg-amber-50 px-4 py-2 text-sm text-amber-950">
      {syncMessage}
    </div>}
    <div ref={target} className="min-h-[400px] flex-1 rounded-lg border bg-white" />
  </div>
}
