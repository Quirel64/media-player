import { useRef, useEffect, useState, useCallback } from 'react'
import type { DragControls } from 'framer-motion'

// Hold ~600ms (modern long-press timing — 1.5s feels broken) to start a drag
// on already-live controls. Any pointer movement first means "scroll", so the
// timer dies and scrolling stays intact.
const HOLD_MS = 600

function buzz() {
  try {
    ;(navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(15)
  } catch {
    /* iOS ignores it — no-op */
  }
}

// touch-action is decided when the gesture STARTS, so flipping classes at
// hold-fire arrives too late on iOS: the browser already claimed scrolling and
// the first move pointercancels the drag. The working fix is a non-passive
// touchmove preventer installed at fire time (finger still stationary, events
// still cancelable) for the rest of that one gesture only.
export function blockTouchScroll() {
  document.addEventListener('touchmove', preventTouchMove, { passive: false })
}

export function unblockTouchScroll() {
  document.removeEventListener('touchmove', preventTouchMove)
}

function preventTouchMove(e: TouchEvent) {
  if (e.cancelable) e.preventDefault()
}

export function useHoldToDrag(
  controls: DragControls,
  opts?: {
    /** Gate evaluated at fire time (e.g. not in select mode). */
    shouldStart?: () => boolean
    /** Runs just before start (e.g. flip visual Order mode — tree is stable). */
    onStarting?: () => void
  },
) {
  const [dragging, setDragging] = useState(false)
  const timer = useRef<number | null>(null)
  const eventRef = useRef<PointerEvent | null>(null)
  // Latest opts without re-creating the timer callback every render.
  const fireOpts = useRef(opts)
  useEffect(() => {
    fireOpts.current = opts
  })

  const clear = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => clear, [clear])
  useEffect(() => unblockTouchScroll, [])

  const end = useCallback(() => {
    clear()
    unblockTouchScroll()
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
        if (fireOpts.current?.shouldStart && !fireOpts.current.shouldStart()) return
        // Finger is still stationary: flip touch-action BEFORE the first move
        // so the browser hands the gesture to the drag, not the scroller.
        setDragging(true)
        buzz()
        try {
          fireOpts.current?.onStarting?.()
        } catch {
          /* visual flip is best-effort */
        }
        if (evt.pointerType === 'touch' || evt.pointerType === 'pen') blockTouchScroll()
        try {
          controls.start(evt)
        } catch {
          unblockTouchScroll()
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
