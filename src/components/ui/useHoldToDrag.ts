import { useRef, useEffect, useCallback } from 'react'
import type { DragControls } from 'framer-motion'

// Hold ~600ms (modern long-press timing — 1.5s feels broken) to start a drag
// from ANYWHERE on the row. Any pointer movement first means "scroll", so the
// timer dies and scrolling stays intact. Complements the visible grip (which
// starts instantly) for users who miss it. Order mode only by call-site.
const HOLD_MS = 600

export function useHoldToDrag(controls: DragControls) {
  const timer = useRef<number | null>(null)
  const eventRef = useRef<PointerEvent | null>(null)

  const clear = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => clear, [clear])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      eventRef.current = e.nativeEvent
      clear()
      timer.current = window.setTimeout(() => {
        timer.current = null
        const evt = eventRef.current
        if (evt) {
          try {
            controls.start(evt)
          } catch {
            /* gesture lost — harmless */
          }
        }
      }, HOLD_MS)
    },
    [controls, clear],
  )

  return { onPointerDown, onPointerMove: clear, onPointerUp: clear, onPointerCancel: clear }
}
