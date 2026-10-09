import { useLayoutEffect, type RefObject } from 'react'

/**
 * Popups open on screen. The browser panel's page is a native view drawn over
 * all of the app's HTML, so the panel watches these and steps its page aside
 * for any that reaches into it.
 */
const open = new Set<HTMLElement>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Register a popup while it is open. */
export function useOverlay(ref: RefObject<HTMLElement | null>, isOpen: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!isOpen || !el) return
    open.add(el)
    // Popups scale in, so their final size is known once the animation ends.
    el.addEventListener('animationend', notify)
    notify()
    return () => {
      el.removeEventListener('animationend', notify)
      open.delete(el)
      notify()
    }
  }, [ref, isOpen])
}

/** Whether an open popup overlaps an element on screen. */
export function overlaysCover(target: HTMLElement): boolean {
  if (open.size === 0) return false
  const rect = target.getBoundingClientRect()
  return [...open].some((el) => {
    const r = el.getBoundingClientRect()
    return r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top
  })
}

/** Called whenever a popup opens, closes or settles. Returns the unsubscribe. */
export function onOverlays(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
