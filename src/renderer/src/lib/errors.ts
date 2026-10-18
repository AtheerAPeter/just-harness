/** An error from the main process as the user should read it, without Electron's IPC prefix. */
export function errorMessage(e: unknown): string {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(e)
}
