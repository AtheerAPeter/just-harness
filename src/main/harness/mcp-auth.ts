import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { RemoteServer } from './mcp'

/**
 * Sign-in for MCP servers that use OAuth. The SDK does the protocol (discovery,
 * client registration, PKCE, token exchange and refresh); this keeps what it
 * saves and receives the browser's redirect. Each CLI keeps its own MCP logins
 * in its own format, so the app signs in once itself and keeps the result here,
 * by server address, readable only by the user.
 */

const file = join(app.getPath('userData'), 'mcp-auth.json')

/** Where the browser comes back to, unless the server's config names another (as opencode's can). */
export const DEFAULT_REDIRECT = 'http://127.0.0.1:19877/mcp/oauth/callback'
/** A sign-in the user has not finished by then is given up. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

interface Saved {
  /** The redirect address the client was registered with; another one needs a new registration. */
  redirectUrl?: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discoveryState?: OAuthDiscoveryState
}

function readAll(): Record<string, Saved> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Saved>
  } catch {
    return {}
  }
}

function update(url: string, change: (saved: Saved) => Saved): void {
  const all = readAll()
  all[url] = change(all[url] ?? {})
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/**
 * The SDK's OAuth client for one server. It never opens the browser itself: a
 * connection that needs a sign-in fails, and the address to sign in at waits
 * in `authorizationUrl` until the user agrees (see signIn).
 */
export class McpOAuth implements OAuthClientProvider {
  authorizationUrl?: URL
  private verifier?: string
  private expectedState?: string

  constructor(private readonly server: RemoteServer) {}

  get redirectUrl(): string {
    return (this.server.oauth && this.server.oauth.redirectUri) || DEFAULT_REDIRECT
  }

  get clientMetadata(): OAuthClientMetadata {
    const oauth = this.server.oauth || {}
    return {
      client_name: 'Just Harness',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: oauth.clientSecret ? 'client_secret_post' : 'none',
      ...(oauth.scope ? { scope: oauth.scope } : {})
    }
  }

  private saved(): Saved {
    return readAll()[this.server.url] ?? {}
  }

  state(): string {
    this.expectedState = randomUUID()
    return this.expectedState
  }

  /** Whether the browser came back from the sign-in this client started. */
  checkState(state: string | null): boolean {
    return Boolean(this.expectedState) && state === this.expectedState
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const oauth = this.server.oauth || {}
    if (oauth.clientId) {
      return {
        client_id: oauth.clientId,
        ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {})
      }
    }
    const saved = this.saved()
    return saved.redirectUrl === this.redirectUrl ? saved.clientInformation : undefined
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    update(this.server.url, (saved) => ({
      ...saved,
      clientInformation,
      redirectUrl: this.redirectUrl
    }))
  }

  tokens(): OAuthTokens | undefined {
    return this.saved().tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    update(this.server.url, (saved) => ({ ...saved, tokens }))
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.saved().discoveryState
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    update(this.server.url, (saved) => ({ ...saved, discoveryState }))
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('The sign-in was not started by this app.')
    return this.verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') {
      this.verifier = undefined
      return
    }
    update(this.server.url, (saved) => {
      if (scope === 'all') return {}
      const { clientInformation, tokens, discoveryState, ...rest } = saved
      return {
        ...rest,
        ...(scope === 'client' ? {} : { clientInformation }),
        ...(scope === 'tokens' ? {} : { tokens }),
        ...(scope === 'discovery' ? {} : { discoveryState })
      }
    })
  }
}

const PAGE = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Just Harness</title><body style="font:15px -apple-system,system-ui,sans-serif;margin:4em auto;max-width:32em;color:#222">${message}</body>`

/**
 * Wait for the browser to come back to the redirect address with the
 * authorization code. Listening starts before the browser is opened (`open`),
 * so the redirect cannot arrive first. Ends with the code, or fails on an error
 * from the server, the user's Stop, or after SIGN_IN_TIMEOUT_MS.
 */
export function waitForRedirect(
  oauth: McpOAuth,
  open: () => Promise<void>,
  signal: AbortSignal
): Promise<string> {
  const redirect = new URL(oauth.redirectUrl)
  return new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', redirect)
      if (url.pathname !== redirect.pathname) {
        response.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      if (!oauth.checkState(url.searchParams.get('state'))) {
        response.writeHead(400, { 'Content-Type': 'text/html' })
        response.end(PAGE('This sign-in was not started by Just Harness.'))
        return
      }
      if (code) {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end(PAGE('Signed in. You can close this tab and go back to Just Harness.'))
        finish(() => resolve(code))
      } else {
        const reason = url.searchParams.get('error_description') || error || 'no code was sent'
        response.writeHead(400, { 'Content-Type': 'text/html' })
        response.end(PAGE(`The sign-in failed: ${escapeHtml(reason)}`))
        finish(() => reject(new Error(`the sign-in failed: ${reason}`)))
      }
    })
    const timer = setTimeout(
      () => finish(() => reject(new Error('the sign-in was not finished within 5 minutes'))),
      SIGN_IN_TIMEOUT_MS
    )
    const onAbort = (): void => finish(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    function finish(settle: () => void): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      server.close()
      settle()
    }
    server.once('error', (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(
                `port ${redirect.port} is in use by another app, so the browser cannot come back to Just Harness`
              )
            : error
        )
      )
    )
    server.listen(Number(redirect.port) || 80, redirect.hostname, () => {
      open().catch((error) => finish(() => reject(error)))
    })
  })
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
