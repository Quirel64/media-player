import { useRef, useEffect, useState, useCallback } from 'react'
import type { DragControls } from 'framer-motion'

// Hold ~600ms (modern long-press timing — 1.5s feels broken) to start a drag
// from ANYWHERE on the row. Any pointer movement first means "scroll", so the
// timer dies and scrolling stays intact. Complements the visible grip (which
// starts instantly) for users who miss it.
const HOLD_MS = 600

function buzz() {
  try {
    ;(navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(15)
  } catch {
    /* iOS ignores it — no-op */
  }
}

export function useHoldToDrag(controls: DragControls) {
  const [dragging, setDragging] = useState(false)
  const timer = useRef<number | null>(null)
  const eventRef = useRef<PointerEvent | null>(null)

  const clear = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => clear, [clear])

  const end = useCallback(() => {
    clear()
    setDragging(false)
  }, [clear])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      eventRef.current = e.nativeEvent
      clear()
      timer.current = window.setTimeout(() => {
        timer.current = null
        const evt = eventRef.current
        if (!evt) return
        // Finger is still stationary: flip touch-action BEFORE the first move
        // so the browser hands the gesture to the drag, not the scroller.
        setDragging(true)
        buzz()
        try {
          controls.start(evt)
        } catch {
          setDragging(false)
        }
      }, HOLD_MS)
    },
    [controls, clear],
  )

  return {
    onPointerDown,
    onPointerMove: clear,
    onPointerUp: end,
    onPointerCancel: end,
    dragging,
  }
}

/**
 * Container-level long-press: enters Order mode from a NORMAL row (no per-row
 * hooks — the id comes from the closest [data-row-id]). Movement cancels, so
 * scrolls and taps never trigger it. No-op when onEnter is undefined.
 */
export function useHoldToEnterOrder(onEnter: (() => void) | undefined) {
  const timer = useRef<number | null>(null)

  const clear = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => clear, [clear])
  useEffect(() => {
    if (!onEnter) clear()
  }, [onEnter, clear])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!onEnter) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const el = (e.target as HTMLElement | null)?.closest?.('[data-row-id]')
      if (!el) return
      clear()
      timer.current = window.setTimeout(() => {
        timer.current = null
        buzz()
        onEnter()
      }, HOLD_MS)
    },
    [onEnter, clear],
  )

  if (!onEnter) {
    return {
      onPointerDown: undefined,
      onPointerMove: undefined,
      onPointerUp: undefined,
      onPointerCancel: undefined,
    }
  }
  return { onPointerDown, onPointerMove: clear, onPointerUp: clear, onPointerCancel: clear }
}
