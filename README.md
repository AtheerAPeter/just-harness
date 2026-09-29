# just-harness

A small macOS desktop app for running the [opencode](https://opencode.ai) and [Cline](https://cline.bot) CLIs. It has no model providers of its own: it starts the CLIs you already have installed, talks to them over the [Agent Client Protocol](https://agentclientprotocol.com) (`opencode acp`, `cline --acp`), and shows the models they report.

## Features

- Projects (folders on disk) with chats inside them. Each chat runs one agent in its project folder.
- Model, provider and effort pickers filled from the agent's live session.
- Built-in browser panel on the right. Logins persist across restarts, and agents can drive it through the `harness_browser` MCP tools. Tag a message with `@browser` to point the agent at it.
- Skills: browse, create and edit `SKILL.md` skills. Type `/` in the composer to pick a skill or an agent command.
- Per-chat bypass-permissions toggle that approves tool requests automatically (allow once).

## Requirements

- macOS
- Node.js 22+
- `opencode` and/or `cline` installed and signed in (`opencode auth login`, `cline auth`)

## Run

```bash
npm install
npm run dev
```

## Build a .app

```bash
npm run build:mac
```

The `.dmg` ends up in `dist/`. The build is unsigned, so on first launch right-click the app and choose Open.

## Where data lives

Chats, settings and the browser profile are stored in `~/Library/Application Support/Just Harness`. Agent sessions themselves are stored by each CLI.
