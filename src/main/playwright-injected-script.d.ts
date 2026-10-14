/** Aliased in electron.vite.config.ts to playwright-core's generated injected script. */
declare module 'playwright-injected-script' {
  /** Source of Playwright's in-page runtime, which defines `module.exports.InjectedScript`. */
  export const source: string
}

/** Aliased in electron.vite.config.ts to playwright-core's US keyboard layout. */
declare module 'playwright-keyboard-layout' {
  /** Keys by their `code` (KeyA, Digit1, Enter...). */
  export const USKeyboardLayout: Record<
    string,
    {
      key: string
      keyCode: number
      shiftKey?: string
      shiftKeyCode?: number
      text?: string
      /** Set for keys that exist twice, such as the keypad's. */
      location?: number
    }
  >
}
