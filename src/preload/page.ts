import { contextBridge, ipcRenderer } from 'electron'

/**
 * Runs in every frame of the built-in browser's pages. alert() and confirm()
 * are answered by the app: it shows them labelled with the site, or the agent
 * driving the page answers them. Electron's own dialogs cannot be answered by
 * an agent. When the app passes (cross-origin iframes, whose dialogs Chromium
 * blocks), the page's own function runs.
 */
contextBridge.executeInMainWorld({
  func: (ask: (type: 'alert' | 'confirm', message: string) => boolean | null) => {
    const nativeAlert = window.alert.bind(window)
    const nativeConfirm = window.confirm.bind(window)
    window.alert = (message?: unknown): void => {
      const text = message === undefined ? '' : String(message)
      if (ask('alert', text) === null) nativeAlert(text)
    }
    window.confirm = (message?: string): boolean => {
      const text = message === undefined ? '' : String(message)
      const answer = ask('confirm', text)
      return answer === null ? nativeConfirm(text) : answer
    }
  },
  // Synchronous like the dialogs themselves: the page waits until it is answered.
  args: [(type: string, message: string) => ipcRenderer.sendSync('page:dialog', type, message)]
})
