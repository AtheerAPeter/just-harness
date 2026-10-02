/**
 * Tool output as the app keeps it: for display only, since the agent holds its
 * own full copy. The chat shows a few lines of it, so binary data is replaced
 * by its type and long text is cut, which keeps chat files, IPC and rendering small.
 */

/** Longest tool output kept, in characters. */
const OUTPUT_MAX = 64 * 1024

/** Agent data (rawInput, rawOutput) as display text, without binary payloads. */
export function formatRaw(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  return JSON.stringify(withoutMedia(value), null, 2)
}

/**
 * Replaces base64 payloads with their type: MCP image and audio content
 * ({data, mimeType}) and embedded resources ({blob, mimeType}).
 */
function withoutMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMedia)
  if (!value || typeof value !== 'object') return value
  const fields = value as Record<string, unknown>
  const payload = fields.data ?? fields.blob
  if (typeof payload === 'string' && typeof fields.mimeType === 'string') {
    return `[${fields.mimeType}]`
  }
  return Object.fromEntries(Object.entries(fields).map(([key, v]) => [key, withoutMedia(v)]))
}

/** Cuts output past OUTPUT_MAX and says how much there was. */
export function limitOutput(text: string): string {
  if (text.length <= OUTPUT_MAX) return text
  const kb = Math.round(text.length / 1024)
  return `${text.slice(0, OUTPUT_MAX)}\n… output truncated (${kb} KB in total)`
}

/**
 * For output saved by earlier versions, which kept screenshots and other
 * payloads in full: strips them if the text is JSON, then applies the limit.
 */
export function cleanStoredOutput(output: string): string {
  if (output.length <= OUTPUT_MAX) return output
  try {
    return limitOutput(formatRaw(JSON.parse(output)) ?? output)
  } catch {
    return limitOutput(output)
  }
}
