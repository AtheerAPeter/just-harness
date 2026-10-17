import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { imageUrl } from '../../../shared/types'
import { useOverlay } from '../lib/overlays'

/** A chat's saved images as small pictures; one opens full size on click. */
export function Thumbnails({
  chatId,
  files
}: {
  chatId: string
  /** Names of the chat's saved images (see main/images.ts). */
  files: string[]
}): React.JSX.Element {
  const [open, setOpen] = useState<string>()
  return (
    <div className="thumbs">
      {/* By position: two attachments with the same contents are one saved file. */}
      {files.map((file, index) => (
        <button
          type="button"
          key={index}
          className="thumb"
          title="View full size"
          onClick={(e) => {
            // Inside a call's row, the click must not also fold the row.
            e.stopPropagation()
            setOpen(file)
          }}
        >
          <img src={imageUrl(chatId, file)} alt="" loading="lazy" draggable={false} />
        </button>
      ))}
      {open && <ImageViewer src={imageUrl(chatId, open)} onClose={() => setOpen(undefined)} />}
    </div>
  )
}

/** An image over the window at its full size, or as large as fits. A click or Escape closes it. */
function ImageViewer({ src, onClose }: { src: string; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useOverlay(ref, true)
  useEffect(() => {
    // Capture phase, and handled: closing the image must not also stop the agent.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  // On the body: a chat block rises in with a transform, which would hold a
  // fixed element inside it while the block moves.
  return createPortal(
    <div className="image-viewer" ref={ref} role="dialog" aria-label="Image" onClick={onClose}>
      <img src={src} alt="" />
    </div>,
    document.body
  )
}
