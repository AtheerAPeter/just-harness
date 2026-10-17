/**
 * An opencode 2 plugin the app loads into its opencode chats (agents.ts,
 * agentEnv). Opencode's shell and subagent tools take `background: true` and
 * promise to resume the session when the work ends. Opencode does resume it,
 * but over ACP that turn never reaches the app (anomalyco/opencode#55760), so
 * the chat looks asleep while the agent works unseen. Such calls are refused
 * here, pointing the model at the harness_chats tools, which wake the chat.
 */

const REFUSALS = new Map([
  [
    'shell',
    'Not run: in Just Harness, a command with background set to true cannot wake this chat when it ends, so you would never hear back. ' +
      'For a long command (a download, a long build or render, a server), call the harness_chats tool run_in_background instead: ' +
      'it wakes this chat with the result. For a short command, leave background out.'
  ],
  [
    'subagent',
    'Not started: in Just Harness, a subagent with background set to true cannot wake this chat when it finishes, so you would never hear back. ' +
      'Run it without background, or hand the task to a new chat with the harness_chats tool start_chat, which reports back.'
  ]
])

export default {
  id: 'just-harness',
  async setup(ctx) {
    await ctx.tool.hook('execute.before', (event) => {
      const refusal = REFUSALS.get(event.tool)
      if (refusal && event.input?.background === true) throw new Error(refusal)
    })
  }
}
