<p align="center">
  <img src="build/icon.png" width="128" alt="Just Harness icon">
</p>

<h1 align="center">Just Harness</h1>

<p align="center"><b>The basics are all you need.</b></p>

<p align="center">A small macOS app for the <a href="https://opencode.ai">opencode</a>, <a href="https://cline.bot">Cline</a> and <a href="https://commandcode.ai">Command Code</a> coding agents: projects, chats, skills, and a built-in browser they can drive. Nothing else.</p>

<p align="center"><a href="https://github.com/AtheerAPeter/just-harness/releases/latest"><b>Download for macOS (Apple Silicon)</b></a></p>

---

Just Harness has no model providers and no API keys of its own. It starts the CLIs you already have installed, talks to them over the [Agent Client Protocol](https://agentclientprotocol.com) (`opencode acp`, `cline --acp`, `cmd acp`), and shows whatever models they report. If a model works in your terminal, it works here.

The exceptions are **Command Code API**, **OpenCode API** and **Cline API**. For these the app runs its own small agent, modeled on [pi](https://github.com/earendil-works/pi): four tools (read, bash, edit, write), opencode's Exa web search, and the browser panel. Web search works without a key on Exa's free tier; add your own Exa API key in Settings (⌘,) to use your Exa account. It calls each provider's API directly with the login its CLI already saved: `cmd login`, `opencode auth login` (Zen and Go) or `cline auth` (usage billing and ClinePass). Model lists come from the providers live, so new models show up without an update. The free models of OpenCode and Cline are not listed: both serve them only to their own apps.

The API agents also get the MCP servers you set up in the matching CLI: OpenCode API reads opencode's `mcp` config, Cline API reads `cline_mcp_settings.json`, and Command Code API reads Command Code's `mcp.json` files and the project's `.mcp.json`. A server that the project's own `opencode.json` sets up or changes comes with the code, so the chat asks before starting it, in every mode. The question says what it runs or connects to, the variables and headers it sets, and the files and variables its config pulls in. A yes is remembered for that exact config and the project files its command runs, and a change to either is asked about again. When a server asks for an OAuth sign-in, the chat offers to open your browser for it. The app keeps that login itself, so you sign in once in the app even if the CLI is already signed in.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘N | New chat |
| ⌘O | Open project folder |
| ⌃⌘S | Show or hide the sidebar |
| ⌘B | Show or hide the browser |
| Enter / Shift+Enter | Send / new line |

## Install

Open Terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/AtheerAPeter/just-harness/main/install.sh | bash
```

It downloads the latest release, installs Just Harness in Applications and opens it. Run it again any time to update. Installing this way skips macOS's "Apple could not verify…" prompt, because only browser downloads get flagged.

Or download the `.dmg` from [Releases](https://github.com/AtheerAPeter/just-harness/releases/latest) and drag Just Harness to Applications. The app isn't notarized by Apple, so the first launch from a browser download is blocked: click **Done**, then **System Settings → Privacy & Security → Open Anyway** (once).

Apple Silicon only. You also need at least one agent installed and signed in:
- opencode: `curl -fsSL https://opencode.ai/install | bash`, then `opencode auth login`
- Cline: `npm i -g cline`, then `cline auth`
- Command Code (1.74 or newer): `npm i -g command-code`, then `cmd login`. Command Code API uses the same login; its API access needs a GOAT plan or higher. OpenCode API and Cline API use the opencode and Cline logins above.

The app finds the CLIs through your login shell's `PATH`, the same way your terminal does.

## Build from source

Requires macOS, Node.js 22+ and npm.

```bash
npm install
npm run dev                                     # run in development
npx electron-vite build && npx electron-builder --mac dmg   # build the .app and .dmg into dist/
```

## How it works

- `src/main/agents.ts` runs one ACP connection per agent CLI, maps chats to ACP sessions, and turns session updates into chat items. Command Code's ACP process serves a single folder, so it gets one connection per project.
- `src/main/harness/` is the app's own agent. `commandcode.ts`, `opencode.ts` and `cline.ts` say where each provider's models live and how to sign in; `catalog.ts` keeps their model lists on disk and refreshes them every 10 minutes. `wire.ts` sends models on Anthropic's `/v1/messages` with the Anthropic SDK and the rest on `/v1/chat/completions` with the OpenAI SDK. Cline's login is shared with the CLI: when it is about to expire, the app renews it under the CLI's own lock and writes it back, so both keep working. `agent.ts` runs the loop and stores each chat as an append-only JSONL transcript. The system prompt is fixed when a chat starts, the tools are always listed in the same order, and each reply is replayed exactly as the API returned it (thinking signatures, reasoning fields). Every request therefore extends the previous one byte for byte and hits the provider's prompt cache. Claude requests carry cache breakpoints on the tools, the system prompt and the newest message.
- `src/main/browser.ts` owns the browser panel, a `WebContentsView` on a persistent session partition, so cookies and logins are stored on disk.
- `src/main/page-driver.ts` drives a page for agents over the DevTools protocol, with Playwright's in-page script for snapshots and element checks (the approach is adapted from ZCode's browser). `src/preload/page.ts` sends a page's alerts and confirms to the app.
- `src/main/browser-mcp.ts` is an MCP server on `127.0.0.1` (bearer-token protected) that exposes the panel to agents. Opencode and Command Code receive it through ACP; Cline's ACP mode ignores MCP servers sent by clients, so the app registers it with `cline mcp add`.
- `src/main/harness/mcp-config.ts` reads each CLI's MCP servers the way that CLI does: file locations, merge order, variable substitution, and servers turned off. `mcp.ts` connects to them with the MCP SDK (stdio, Streamable HTTP, SSE). A chat's first request takes their tools, named `mcp__<server>__<tool>`, into its fixed tool list. `mcp-auth.ts` handles OAuth sign-in through the SDK and keeps the tokens in `mcp-auth.json`, readable only by you.
- `src/main/skills.ts` reads skills from `.claude/skills`, `.opencode/skills`, `.agents/skills`, `.cline/skills`, `.commandcode/skills` and their global equivalents.

Chats, settings and the browser profile are stored in `~/Library/Application Support/Just Harness`. The agent sessions themselves are stored by each CLI.

## Known limitations

- Cline's ACP mode currently ignores reasoning effort (`--thinking`), so there's no effort picker for Cline.
- Command Code API has no compaction. Start a new chat when one gets long.
- An API chat's MCP tools are set when the chat starts. A server you add or sign in to later shows up in the next new chat.
- The app reads only `PATH` from your login shell. Other variables exported in `.zshrc` are not seen by `{env:…}` or `${…}` in MCP configs, or by stdio servers.
- Cline starts a background "hub" process of its own that keeps running after the app quits.
- Apple Silicon only for now, and not notarized (see Install).

## License

[MIT](LICENSE). Bundled third-party code is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
