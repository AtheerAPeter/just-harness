<p align="center">
  <img src="build/icon.png" width="128" alt="Just Harness icon">
</p>

<h1 align="center">Just Harness</h1>

<p align="center"><b>The basics are all you need.</b></p>

<p align="center">A small macOS app for the <a href="https://opencode.ai">opencode</a>, <a href="https://cline.bot">Cline</a> and <a href="https://commandcode.ai">Command Code</a> coding agents: projects, chats, skills, and a built-in browser they can drive. Nothing else.</p>

<p align="center"><a href="https://github.com/AtheerAPeter/just-harness/releases/latest"><b>Download for macOS (Apple Silicon)</b></a></p>

---

Just Harness has no model providers and no API keys of its own. It starts the CLIs you already have installed, talks to them over the [Agent Client Protocol](https://agentclientprotocol.com) (`opencode acp`, `cline --acp`, `cmd acp`), and shows whatever models they report. If a model works in your terminal, it works here.

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
- Command Code (1.74 or newer): `npm i -g command-code`, then `cmd login`

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
- `src/main/browser.ts` owns the browser panel, a `WebContentsView` on a persistent session partition, so cookies and logins are stored on disk.
- `src/main/page-driver.ts` drives a page for agents over the DevTools protocol, with Playwright's in-page script for snapshots and element checks (the approach is adapted from ZCode's browser). `src/preload/page.ts` sends a page's alerts and confirms to the app.
- `src/main/browser-mcp.ts` is an MCP server on `127.0.0.1` (bearer-token protected) that exposes the panel to agents. Opencode and Command Code receive it through ACP; Cline's ACP mode ignores MCP servers sent by clients, so the app registers it with `cline mcp add`.
- `src/main/skills.ts` reads skills from `.claude/skills`, `.opencode/skills`, `.agents/skills`, `.cline/skills`, `.commandcode/skills` and their global equivalents.

Chats, settings and the browser profile are stored in `~/Library/Application Support/Just Harness`. The agent sessions themselves are stored by each CLI.

## Known limitations

- Cline's ACP mode currently ignores reasoning effort (`--thinking`), so there's no effort picker for Cline.
- Cline starts a background "hub" process of its own that keeps running after the app quits.
- Apple Silicon only for now, and not notarized (see Install).

## License

[MIT](LICENSE). Bundled third-party code is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
