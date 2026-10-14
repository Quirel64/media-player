import { useRef, useState, useEffect, useCallback } from 'react'

/**
 * Pointer-driven vertical list reorder with NO layout-measurement framework.
 *
 * Why this exists: framer-motion Reorder keeps measured snapshots that go
 * stale on any re-render (track change, select toggle, check/uncheck, tilt) —
 * rows then stack at the container edge, and no remount key covers every
 * trigger. Here positions are pure document flow EXCEPT the actively dragged
 * row (one inline transform, cleared at drop). Nothing to go stale: re-renders
 * mid-drag only swap classes, and a track change aborts the drag silently.
 *
 * Contract:
 * - start(id, clientY): finger down on grip/held row. Measures once.
 * - moves handled on window (passive reads only — scroll ownership stays with
 *   the existing touch-action/blocker machinery, untouched).
 * - Shifts applied DIRECTLY to row elements (no React state per frame).
 * - Drop (or cancel) clears inline styles; onCommit fires once with full ids.
 * - Clicks within 300ms of a drag end are suppressed (tap-vs-drop).
 * - Edge autoscroll while held near the container bounds.
 */

interface DragSession {
  id: string
  startContentY: number
  /** Finger offset inside the row at grab time — preserved so no snap. */
  grabOffset: number
  pointerId: number
  order: string[]
  startIdx: number
  targetIdx: number
  tops: Map<string, number>
  rowH: number
}

export function useRowDrag(opts: {
  ids: string[]
  onCommit: (newIds: string[]) => void
  getScrollEl: () => HTMLElement | null
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const els = useRef(new Map<string, HTMLElement>())
  const session = useRef<DragSession | null>(null)
  const endAt = useRef(0)
  const scrollTimer = useRef<number | null>(null)
  const lastClientY = useRef(0)
  // Latest values without rebinding window listeners every render.
  const live = useRef(opts)
  useEffect(() => {
    live.current = opts
  })

  const registerRow = useCallback((id: string, el: HTMLElement | null) => {
    if (el) els.current.set(id, el)
    else els.current.delete(id)
  }, [])

  const clearInlineStyles = useCallback(() => {
    for (const el of els.current.values()) {
      el.style.transform = ''
      el.style.transition = ''
      el.style.zIndex = ''
    }
  }, [])

  const stopScrollTimer = useCallback(() => {
    if (scrollTimer.current != null) {
      clearInterval(scrollTimer.current)
      scrollTimer.current = null
    }
  }, [])

  const finish = useCallback(
    (commit: boolean) => {
      const s = session.current
      if (!s) return
      session.current = null
      stopScrollTimer()
      window.removeEventListener('pointermove', onMoveRef.current)
      window.removeEventListener('pointerup', onUpRef.current)
      window.removeEventListener('pointercancel', onCancelRef.current)
      clearInlineStyles()
      setDragId(null)
      // Marks the gesture end so the release click (mouse) doesn't leak
      // through as a tap-to-play. Idle cancels never touch it.
      endAt.current = Date.now()
      if (commit && s.targetIdx !== s.startIdx) {
        const next = s.order.filter((id) => id !== s.id)
        next.splice(s.targetIdx, 0, s.id)
        live.current.onCommit(next)
      }
    },
    [clearInlineStyles, stopScrollTimer],
  )
  const finishRef = useRef(finish)
  useEffect(() => {
    finishRef.current = finish
  })

  const measure = useCallback((): Map<string, number> | null => {
    const scroller = live.current.getScrollEl()
    if (!scroller) return null
    const cTop = scroller.getBoundingClientRect().top
    const tops = new Map<string, number>()
    for (const [id, el] of els.current) {
      tops.set(id, el.getBoundingClientRect().top - cTop + scroller.scrollTop)
    }
    return tops
  }, [])

  const applyShifts = useCallback((s: DragSession, pointerContentY: number) => {
    // Insertion slot among the OTHER rows by midpoint.
    let slot = 0
    for (const id of s.order) {
      if (id === s.id) continue
      const top = s.tops.get(id)
      if (top == null) continue
      const h = els.current.get(id)?.offsetHeight ?? s.rowH
      if (pointerContentY > top + h / 2) slot += 1
    }
    // slot counts others-before-pointer = the dragged row's full-array index.
    s.targetIdx = Math.max(0, Math.min(slot, s.order.length - 1))
    const lo = Math.min(s.startIdx, s.targetIdx)
    const hi = Math.max(s.startIdx, s.targetIdx)
    for (const [id, el] of els.current) {
      if (id === s.id) continue
      const i = s.order.indexOf(id)
      if (i >= lo && i <= hi) {
        const dir = s.targetIdx > s.startIdx ? -1 : 1
        el.style.transition = 'transform 160ms ease'
        el.style.transform = `translateY(${dir * s.rowH}px)`
      } else {
        el.style.transition = 'transform 160ms ease'
        el.style.transform = ''
      }
    }
  }, [])

  const onMoveRef = useRef((_e: PointerEvent) => {})
  const onUpRef = useRef((_e: PointerEvent) => {})
  const onCancelRef = useRef((_e: PointerEvent) => {})

  const start = useCallback(
    (id: string, clientY: number, pointerId?: number) => {
      if (session.current) return
      const scroller = live.current.getScrollEl()
      if (!scroller) return
      const order = [...live.current.ids]
      const startIdx = order.indexOf(id)
      if (startIdx === -1) return
      const tops = measure()
      if (!tops || !tops.has(id)) return
      const draggedEl = els.current.get(id)
      if (!draggedEl) return
      const rowH = draggedEl.offsetHeight || 56
      // Content-space anchor: viewport dy drifts whenever the container
      // autoscrolls under the finger (row lags behind it). Content coords
      // stay glued to the finger regardless of scroll.
      const cTop = scroller.getBoundingClientRect().top
      const startContentY = clientY - cTop + scroller.scrollTop
      session.current = {
        id,
        startContentY,
        grabOffset: startContentY - (tops.get(id) ?? startContentY),
        pointerId: pointerId ?? -1,
        order,
        startIdx,
        targetIdx: startIdx,
        tops,
        rowH,
      }
      lastClientY.current = clientY
      setDragId(id)
      draggedEl.style.transition = 'none'
      draggedEl.style.zIndex = '10'

      const doMove = (e: PointerEvent) => {
        const s = session.current
        if (!s) return
        if (s.pointerId !== -1 && e.pointerId !== s.pointerId) return
        lastClientY.current = e.clientY
        const sc = live.current.getScrollEl()
        if (!sc) return
        const cTop = sc.getBoundingClientRect().top
        const contentY = e.clientY - cTop + sc.scrollTop
        // Clamp the dragged row inside the list so it can't leave the screen.
        const maxTop = Math.max(0, sc.scrollHeight - s.rowH)
        const wantTop = Math.max(0, Math.min(contentY - s.grabOffset, maxTop))
        const dy = wantTop - (s.tops.get(s.id) ?? wantTop)
        const el = els.current.get(s.id)
        if (el) el.style.transform = `translateY(${dy}px)`
        applyShifts(s, contentY)
      }
      const doUp = (e: PointerEvent) => {
        const s = session.current
        if (!s) return
        if (s.pointerId !== -1 && e.pointerId !== s.pointerId) return
        finishRef.current(true)
      }
      const doCancel = () => {
        finishRef.current(false)
      }
      onMoveRef.current = doMove
      onUpRef.current = doUp
      onCancelRef.current = doCancel
      window.addEventListener('pointermove', doMove)
      window.addEventListener('pointerup', doUp)
      window.addEventListener('pointercancel', doCancel)

      // Edge autoscroll while held near the bounds. Gentle on purpose: fast
      // scrolling plus layout shifts read as the row lagging behind the finger.
      stopScrollTimer()
      scrollTimer.current = window.setInterval(() => {
        const s = session.current
        const sc = live.current.getScrollEl()
        if (!s || !sc) return
        const r = sc.getBoundingClientRect()
        const y = lastClientY.current
        const MARGIN = 64
        const STEP = 8
        if (y < r.top + MARGIN) sc.scrollTop = Math.max(0, sc.scrollTop - STEP)
        else if (y > r.bottom - MARGIN) sc.scrollTop += STEP
      }, 50)
    },
    [measure, applyShifts, stopScrollTimer],
  )

  // External order changes mid-drag (track switch, select toggle, tilt):
  // positions are pure flow, so just abort the gesture — nothing can pile.
  // No-op when idle (crucially: never touches the click-suppression stamp).
  const cancel = useCallback(() => {
    if (!session.current) return
    finishRef.current(false)
  }, [])
  const idsKey = opts.ids.join('|')
  useEffect(() => {
    cancel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  useEffect(
    () => () => {
      stopScrollTimer()
      window.removeEventListener('pointermove', onMoveRef.current)
      window.removeEventListener('pointerup', onUpRef.current)
      window.removeEventListener('pointercancel', onCancelRef.current)
    },
    [stopScrollTimer],
  )

  const shouldSuppressClick = useCallback(() => Date.now() - endAt.current < 300, [])

  return { dragId, registerRow, start, cancel, shouldSuppressClick }
}
