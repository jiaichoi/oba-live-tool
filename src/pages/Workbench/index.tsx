import { useEffect, useRef } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'

/** Native WebContentsView keeps the order console first-party for its strict login cookie. */
export default function Workbench() {
  const target = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = target.current
    if (!element) return
    const show = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      void window.ipcRenderer.invoke(IPC_CHANNELS.workbench.show, {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
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
  }, [])

  return (
    <div className="h-full min-h-[400px] flex flex-col">
      <div className="mb-3">
        <h2 className="text-xl font-semibold">订单工作台</h2>
        <p className="text-sm text-muted-foreground">
          本机订单服务显示在下方。直播发言、弹窗、自动回复和红包功能需分别进入对应页面手动启动。
        </p>
      </div>
      <div ref={target} className="flex-1 min-h-[320px] rounded-lg border bg-white" />
    </div>
  )
}
