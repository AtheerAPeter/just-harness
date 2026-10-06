import { useState } from 'react'

/**
 * Content that opens and closes by animating its height, both ways. The
 * content mounts on the first open and stays mounted, so closing can animate
 * too; while closed it is skipped by rendering and unreachable by keyboard.
 */
export function Collapse({
  open,
  className,
  children
}: {
  open: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [opened, setOpened] = useState(open)
  if (open && !opened) setOpened(true)
  return (
    <div className={`collapse${open ? ' open' : ''}`} inert={!open}>
      {opened && <div className={className}>{children}</div>}
    </div>
  )
}
