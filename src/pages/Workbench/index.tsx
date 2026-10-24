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

let nextWorkbenchMount = 0

/** The native view keeps local forms, filters and order details on their own origin. */
export default function Workbench({ path }: { path: string }) {
  const target = useRef<HTMLDivElement>(null)
  const mountKey = useRef(++nextWorkbenchMount)
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
      // The bottom log panel reduces the visible content area. Keep the native
      // view inside the window instead of sending its offscreen CSS height.
      const offset = path === '/due' ? 64 : 0
      const width = Math.min(Math.round(rect.width + offset), Math.floor(window.innerWidth - rect.x + offset - 2))
      const height = Math.min(Math.round(rect.height), Math.floor(window.innerHeight - rect.y + offset - 150), path === '/due' ? 260 : Number.MAX_SAFE_INTEGER)
      if (width < 1 || height < 1) return
      void window.ipcRenderer.invoke(IPC_CHANNELS.workbench.show, {
        x: Math.max(0, Math.round(rect.x - offset)), y: Math.max(0, Math.round(rect.y - offset)),
        width, height, viewportWidth: window.innerWidth,
        path, requestKey: `${location.key}:${mountKey.current}`, preservePath,
      }).catch(error => console.error('本机订单视图显示失败', error))
    }
    const observer = new ResizeObserver(show)
    observer.observe(element)
    window.addEventListener('resize', show)
    show()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', show)
      void window.ipcRenderer.invoke(IPC_CHANNELS.workbench.hide, `${location.key}:${mountKey.current}`)
    }
  }, [path, location.key, preservePath])

  return <div className="flex h-full flex-col gap-2">
    {path !== '/due' && syncMessage && <div role="status" className="rounded-lg border bg-amber-50 px-4 py-2 text-sm text-amber-950">{syncMessage}</div>}
    <div ref={target} className="min-h-[400px] flex-1 rounded-lg border bg-white" />
  </div>
}
