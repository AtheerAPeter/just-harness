import { Menu, type MenuItemConstructorOptions } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { Theme } from '../shared/types'

/** Commands the renderer handles; menu items send these. */
export type MenuCommand = 'new-chat' | 'open-project' | 'toggle-sidebar' | 'toggle-browser'

/**
 * The native menu bar. Its accelerators work wherever focus is, including
 * inside the browser page, and macOS lists each shortcut next to its item.
 */
export function installMenu(
  run: (command: MenuCommand) => void,
  theme: Theme,
  setTheme: (theme: Theme) => void
): void {
  const appearance = (label: string, value: Theme): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: theme === value,
    click: () => setTheme(value)
  })
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => run('new-chat') },
        {
          label: 'Open Project Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => run('open-project')
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // Apple's standard shortcut for showing and hiding a sidebar.
        { label: 'Toggle Sidebar', accelerator: 'Ctrl+Cmd+S', click: () => run('toggle-sidebar') },
        { label: 'Toggle Browser', accelerator: 'CmdOrCtrl+B', click: () => run('toggle-browser') },
        {
          label: 'Appearance',
          submenu: [
            appearance('System', 'system'),
            appearance('Light', 'light'),
            appearance('Dark', 'dark')
          ]
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(is.dev ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : [])
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
