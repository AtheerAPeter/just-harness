import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Links open in the system browser (the main process denies in-app windows and calls openExternal).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer')
  }
})

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: false }))
}
