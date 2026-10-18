/** Gap between a picker's button and its menu, plus the space kept from the window's edge. */
const MARGIN = 10 + 12

export interface MenuPlacement {
  side: 'above' | 'below'
  /** The height the menu may take on that side, in px. */
  room: number
}

/**
 * Where a picker's menu opens: on the side of its button with more room, and
 * no taller than that, so the window never cuts it off. The pickers sit under
 * the composer, which is at the window's bottom in a chat and mid-window in an
 * empty one.
 */
export function menuPlacement(anchor: HTMLElement): MenuPlacement {
  const rect = anchor.getBoundingClientRect()
  const above = rect.top - MARGIN
  const below = window.innerHeight - rect.bottom - MARGIN
  return below > above ? { side: 'below', room: below } : { side: 'above', room: above }
}

/** The menu element's props for a placement (see .picker-menu in styles.css). */
export function placementProps(placement: MenuPlacement): {
  'data-side': MenuPlacement['side']
  style: React.CSSProperties
} {
  return {
    'data-side': placement.side,
    style: { '--menu-room': `${placement.room}px` } as React.CSSProperties
  }
}
