import type { WebContents } from 'electron'
import { source as playwrightSource } from 'playwright-injected-script'

/**
 * Agent automation for one browser page over the DevTools protocol, built the
 * way ZCode's browser is, on Playwright's in-page runtime (both Apache-2.0):
 *
 * - Snapshots are Playwright's ARIA snapshot for AI: roles, accessible names
 *   and states, shadow DOM, and iframes, with refs (e5, or f1e5 in frame 1).
 * - Before a click or hover, the element must be visible, enabled, still and
 *   the topmost element at its centre. Overlays and animations make the action
 *   fail with the reason, instead of clicking something else.
 * - Mouse and keyboard input are real input events, and every command has a
 *   time limit, so a busy page cannot hang an agent.
 *
 * Playwright's script runs in an isolated world: the page cannot see it, and
 * page scripts that replace built-ins cannot break it.
 */

const WORLD = 'just-harness'
const INJECTED = '__justHarnessInjected'
/** DevTools commands answer in milliseconds; a page that takes this long is stuck. */
const COMMAND_TIMEOUT = 10_000
/** How long an element may take to become ready for an action. */
const ACTION_TIMEOUT = 5_000
/** How long a snapshot may spend reading iframes. */
const FRAMES_TIMEOUT = 2_000
/** Longest snapshot returned, in characters, so one page cannot flood the model. */
const MAX_SNAPSHOT = 50_000
/** Ways to scroll an element into view, tried in turn to get it out from under sticky bars. */
const ALIGNMENTS = ['center', 'end', 'start', 'nearest']

const INJECT = `(() => {
  const module = {};
  ${playwrightSource}
  globalThis.${INJECTED} = new (module.exports.InjectedScript())(globalThis, ${JSON.stringify({
    browserName: 'chromium',
    customEngines: [],
    isUnderTest: false,
    sdkLanguage: 'javascript',
    stableRafCount: 1,
    testIdAttributeName: 'data-testid'
  })});
})()`

// Functions run in a frame's isolated world. They are strings so the bundler
// leaves them exactly as written.

const FIND = `const injected = globalThis.${INJECTED};
  const element = injected.querySelectorAll(injected.parseSelector('aria-ref=' + ref), document)[0];`

/** Checks Playwright element states, in order; returns the first that fails. */
const FAILED_STATE = `const failedState = (states) => {
    for (const state of states) {
      const result = injected.elementState(element, state);
      if (result.received === 'error:notconnected') return 'missing';
      if (!result.matches) return state;
    }
  };`

const SNAPSHOT = `function (refPrefix) {
  const injected = globalThis.${INJECTED};
  const root = document.body || document.documentElement;
  if (!root) return { full: '', iframeRefs: [] };
  const snapshot = injected.incrementalAriaSnapshot(root, { mode: 'ai', refPrefix });
  return {
    full: snapshot.full,
    iframeRefs: snapshot.iframeRefs.filter((ref) => ref in snapshot.iframeDepths)
  };
}`

const ELEMENT = `function (ref) {
  ${FIND}
  return element || null;
}`

/** Actionability checks before an action; returns the element's centre in its frame. */
const PROBE = `async function (ref, options) {
  ${FIND}
  if (!element) return { problem: 'missing' };
  ${FAILED_STATE}
  let problem = failedState(options.states);
  if (problem) return { problem };
  element.scrollIntoView({ block: options.align, inline: options.align, behavior: 'instant' });
  let rect = element.getBoundingClientRect();
  if (options.stable) {
    // Still for two animation frames in a row, like Playwright.
    const frame = () => new Promise((resolve) => {
      requestAnimationFrame(resolve);
      setTimeout(resolve, 100);
    });
    let still = 0;
    for (let i = 0; i < 10 && still < 2; i++) {
      await frame();
      const next = element.getBoundingClientRect();
      const same = next.x === rect.x && next.y === rect.y &&
        next.width === rect.width && next.height === rect.height;
      still = same ? still + 1 : 0;
      rect = next;
    }
    if (still < 2) return { problem: 'moving' };
  }
  problem = failedState(options.states);
  if (problem) return { problem };
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (!options.onTop) return { x, y };
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { problem: 'outside' };
  const hit = injected.expectHitTarget({ x, y }, element);
  return hit === 'done' ? { x, y } : { problem: 'covered', by: hit.hitTargetDescription };
}`

/** Playwright's fill: sets values like dates directly, or selects the text to be replaced. */
const FILL = `function (ref, value) {
  ${FIND}
  if (!element) return { problem: 'missing' };
  ${FAILED_STATE}
  const problem = failedState(['visible', 'enabled', 'editable']);
  if (problem) return { problem };
  return { filled: injected.fill(element, value) };
}`

const SELECT = `function (ref, values) {
  ${FIND}
  if (!element) return { problem: 'missing' };
  ${FAILED_STATE}
  const problem = failedState(['visible', 'enabled']);
  if (problem) return { problem };
  const result = injected.selectOptions(element, values.map((value) => ({ valueOrLabel: value })));
  if (Array.isArray(result)) return { selected: result };
  if (result === 'error:notconnected') return { problem: 'missing' };
  const select = injected.retarget(element, 'follow-label');
  return { problem: result.slice('error:'.length), options: [...select.options].map((o) => o.label) };
}`

/** Called on an <iframe>: a point in its content, in its parent frame, and what covers it. */
const FRAME_POINT = `function (x, y, onTop) {
  const rect = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  const point = {
    x: rect.left + this.clientLeft + parseFloat(style.paddingLeft) + x,
    y: rect.top + this.clientTop + parseFloat(style.paddingTop) + y
  };
  if (!onTop) return point;
  const hit = globalThis.${INJECTED}.expectHitTarget(point, this);
  return hit === 'done' ? point : { ...point, coveredBy: hit.hitTargetDescription };
}`

/** The file field for an upload ref: the ref itself, one inside or labelled by it, or the only one. */
const FILE_INPUT = `function (ref) {
  ${FIND}
  const isFileInput = (node) => node instanceof HTMLInputElement && node.type === 'file';
  if (element && isFileInput(element)) return element;
  const near = element && (element.querySelector('input[type=file]') ||
    (element.closest('label') && element.closest('label').control));
  if (near && isFileInput(near)) return near;
  const all = document.querySelectorAll('input[type=file]');
  return all.length === 1 ? all[0] : null;
}`

/**
 * Scroll the area that contains an element (or the middle of the page) the
 * way a wheel would: the nearest container that can still move that way,
 * else the page. Wheel events only scroll pages that are on screen.
 */
const SCROLL = `function (ref, pixels) {
  const injected = globalThis.${INJECTED};
  const start = ref
    ? injected.querySelectorAll(injected.parseSelector('aria-ref=' + ref), document)[0]
    : document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  if (ref && !start) return { problem: 'missing' };
  const page = document.scrollingElement || document.documentElement;
  const canMove = (node) => {
    if (!/auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) return false;
    return pixels > 0
      ? node.scrollTop + node.clientHeight < node.scrollHeight - 1
      : node.scrollTop > 0;
  };
  let scroller = page;
  for (let node = start; node && node !== document.body && node !== document.documentElement;
    node = node.parentElement || (node.getRootNode() && node.getRootNode().host)) {
    if (canMove(node)) {
      scroller = node;
      break;
    }
  }
  const before = scroller.scrollTop;
  scroller.scrollBy({ top: pixels, behavior: 'instant' });
  return {
    done: {
      moved: Math.round(scroller.scrollTop - before),
      area: scroller === page ? 'the page' : injected.previewNode(scroller)
    }
  };
}`

/**
 * A click made inside the page, for pages that are not on screen: the events
 * a real click fires, at the same point, ending in the click itself.
 */
const CLICK_IN_PAGE = `function (ref, x, y) {
  ${FIND}
  if (!element) return false;
  const target = element.getRootNode().elementFromPoint(x, y) || element;
  const mouse = { bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, button: 0, detail: 1 };
  const pointer = { ...mouse, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  target.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
  if (target.dispatchEvent(new MouseEvent('mousedown', { ...mouse, buttons: 1 }))) {
    const focusable = target.closest('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]');
    if (focusable) focusable.focus({ preventScroll: true });
  }
  target.dispatchEvent(new PointerEvent('pointerup', pointer));
  target.dispatchEvent(new MouseEvent('mouseup', mouse));
  target.dispatchEvent(new MouseEvent('click', mouse));
  return true;
}`

/**
 * A key press made inside the page, for pages that are not on screen, on the
 * focused element. Enter in a form field submits its form, as browsers do.
 * Returns whether the page let the key through (did not prevent it).
 */
const KEY_IN_PAGE = `function (key, modifiers) {
  let target = document.activeElement || document.body;
  for (;;) {
    const inner = (target.shadowRoot && target.shadowRoot.activeElement) ||
      (target.contentDocument && target.contentDocument.activeElement);
    if (!inner) break;
    target = inner;
  }
  const code = /^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase()
    : /^[0-9]$/.test(key) ? 'Digit' + key : key.length > 1 ? key : '';
  const init = { key, code, bubbles: true, cancelable: true, composed: true,
    metaKey: modifiers.includes('cmd'), shiftKey: modifiers.includes('shift'),
    altKey: modifiers.includes('alt'), ctrlKey: modifiers.includes('ctrl') };
  const allowed = target.dispatchEvent(new KeyboardEvent('keydown', init));
  if (allowed && key === 'Enter' && target.form && target.matches('input')) {
    target.form.requestSubmit();
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return allowed;
}`

/** A frame of the page, and the DevTools session its document lives in. */
interface FrameTarget {
  frameId: string
  /** Out-of-process iframes have their own session; the page's process has none. */
  sessionId?: string
  /** The frame holding this frame's <iframe>; none for the page itself. */
  parent?: FrameTarget
}

interface Point {
  x: number
  y: number
}

/** A page function's answer: the result, or why the element is not ready yet. */
type Attempt<T> = { done: T } | { problem: string; by?: string }

interface RemoteResult {
  result: { value?: unknown; objectId?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

const PROBLEMS: Record<string, (by?: string) => string> = {
  visible: () => 'is not visible',
  enabled: () => 'is disabled',
  editable: () => 'is read-only',
  moving: () => 'keeps moving (it is still animating)',
  outside: () => 'is outside the visible part of the page',
  covered: (by) => `is covered by ${by}, which would get the click instead`
}

/** Errors that mean the document or frame went away mid-command. */
const PAGE_CHANGED =
  /context was destroyed|cannot find context|no frame for given id|frame with the given id was not found|inspected target navigated or closed/i

function staleRef(ref: string): string {
  return `No element with ref ${ref}. Refs change when the page does; take a new snapshot.`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(error()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function valueOf(response: RemoteResult): unknown {
  const details = response.exceptionDetails
  if (details) {
    const message = details.exception?.description ?? details.text ?? 'The script failed'
    // Keep the message, not the stack of Playwright's bundled script.
    throw new Error(message.replace(/\n\s+at [\s\S]*$/, ''))
  }
  return response.result.value
}

export class PageDriver {
  private readonly cdp: Electron.Debugger
  private attaching?: Promise<void>
  /** DevTools sessions of out-of-process iframes, by frame id. */
  private readonly frameSessions = new Map<string, string>()
  /** Numbers that name iframes in refs (f1e5), stable while the page lives. */
  private readonly frameNumbers = new Map<string, number>()
  /** Iframes in the latest snapshot, by number. */
  private frames = new Map<number, FrameTarget>()
  private readonly eventListeners = new Set<
    (method: string, params: unknown, sessionId?: string) => void
  >()

  constructor(
    private readonly contents: WebContents,
    /**
     * Electron opened its own dialog (one the page preload did not catch), or
     * it closed (undefined). Only the user can answer it.
     */
    private readonly onNativeDialog: (
      dialog: { type: 'alert' | 'confirm'; message: string } | undefined
    ) => void,
    /**
     * Whether the page is on screen. Chromium drops clicks and key presses for
     * a page whose document has not been shown, so pages of background chats,
     * parked out of sight, get those events made inside the page instead.
     */
    private readonly onScreen: () => boolean
  ) {
    this.cdp = contents.debugger
  }

  private attach(): Promise<void> {
    this.attaching ??= this.connect().catch((error) => {
      this.detach()
      throw error
    })
    return this.attaching
  }

  private async connect(): Promise<void> {
    // Commands sent before a page commits its first document never answer.
    if (!this.contents.getURL()) await this.firstDocument()
    this.cdp.attach('1.3')
    this.cdp.on('message', this.onMessage)
    this.cdp.on('detach', this.reset)
    await this.send('Page.enable')
    await this.followIframes()
  }

  private firstDocument(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.contents.off('did-navigate', done)
        this.contents.off('did-fail-load', done)
        resolve()
      }
      const timer = setTimeout(done, COMMAND_TIMEOUT)
      this.contents.on('did-navigate', done)
      this.contents.on('did-fail-load', done)
    })
  }

  /** Cross-site iframes run in their own process and need their own sessions. */
  private followIframes(sessionId?: string): Promise<unknown> {
    return this.send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'iframe' }]
      },
      sessionId
    )
  }

  /**
   * Disconnect from the page. Called before it closes and when its renderer
   * crashes: Electron can crash the whole app if a page is destroyed while the
   * debugger is still attached.
   */
  detach(): void {
    if (!this.attaching) return
    try {
      if (!this.contents.isDestroyed() && this.cdp.isAttached()) this.cdp.detach()
    } catch {
      // The page is already gone.
    }
    this.reset()
  }

  private readonly reset = (): void => {
    this.cdp.off('message', this.onMessage)
    this.cdp.off('detach', this.reset)
    this.attaching = undefined
    this.frameSessions.clear()
    this.frames.clear()
    this.onNativeDialog(undefined)
  }

  private readonly onMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): void => {
    if (method === 'Target.attachedToTarget') {
      const childSession = params.sessionId as string
      const target = params.targetInfo as { targetId: string }
      // An iframe target's id is its frame id.
      this.frameSessions.set(target.targetId, childSession)
      this.send('Page.enable', {}, childSession).catch(() => undefined)
      this.followIframes(childSession).catch(() => undefined)
    } else if (method === 'Target.detachedFromTarget') {
      for (const [frameId, id] of this.frameSessions) {
        if (id === params.sessionId) this.frameSessions.delete(frameId)
      }
    } else if (!sessionId && method === 'Page.javascriptDialogOpening') {
      // prompt() and beforeunload are answered by Electron at once, never shown.
      if (params.type === 'alert' || params.type === 'confirm') {
        this.onNativeDialog({ type: params.type, message: params.message as string })
      }
    } else if (!sessionId && method === 'Page.javascriptDialogClosed') {
      this.onNativeDialog(undefined)
    }
    for (const listener of this.eventListeners) listener(method, params, sessionId || undefined)
  }

  /** The next event of this kind from a session, or undefined after `timeout`. */
  private nextEvent<T>(
    method: string,
    sessionId: string | undefined,
    timeout: number
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      const listener = (name: string, params: unknown, from?: string): void => {
        if (name === method && from === sessionId) finish(params as T)
      }
      const finish = (value: T | undefined): void => {
        clearTimeout(timer)
        this.eventListeners.delete(listener)
        resolve(value)
      }
      const timer = setTimeout(() => finish(undefined), timeout)
      this.eventListeners.add(listener)
    })
  }

  private async send<T = unknown>(
    method: string,
    params: object = {},
    sessionId?: string,
    timeout = COMMAND_TIMEOUT
  ): Promise<T> {
    try {
      return await withTimeout(
        this.cdp.sendCommand(method, params, sessionId) as Promise<T>,
        timeout,
        () =>
          new Error(
            `The page did not respond within ${timeout / 1000}s (${method}). It may be busy or frozen.`
          )
      )
    } catch (error) {
      if (PAGE_CHANGED.test((error as Error).message)) {
        throw new Error(
          'The page changed while it was being read (it navigated or a frame went away). Take a new snapshot.'
        )
      }
      throw error
    }
  }

  private async mainFrame(): Promise<FrameTarget> {
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree'
    )
    return { frameId: frameTree.frame.id }
  }

  /** The frame's isolated world, with Playwright's script loaded once per document. */
  private async context(frame: FrameTarget): Promise<number> {
    const { executionContextId } = await this.send<{ executionContextId: number }>(
      'Page.createIsolatedWorld',
      // Sic: the protocol spells it this way.
      { frameId: frame.frameId, worldName: WORLD, grantUniveralAccess: false },
      frame.sessionId
    )
    const evaluate = (expression: string): Promise<RemoteResult> =>
      this.send<RemoteResult>(
        'Runtime.evaluate',
        { expression, contextId: executionContextId, returnByValue: true },
        frame.sessionId
      )
    if (!valueOf(await evaluate(`Boolean(globalThis.${INJECTED})`))) valueOf(await evaluate(INJECT))
    return executionContextId
  }

  /** Run a page function in a frame's world, or on an object in it, and return its result. */
  private async call<T>(
    frame: FrameTarget,
    target: { contextId: number } | { objectId: string },
    fn: string,
    args: unknown[],
    /** Run as if the user had just interacted, so the page may open popups and pickers. */
    userGesture = false
  ): Promise<T> {
    const response = await this.send<RemoteResult>(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: fn,
        ...('objectId' in target
          ? { objectId: target.objectId }
          : { executionContextId: target.contextId }),
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
        userGesture
      },
      frame.sessionId
    )
    return valueOf(response) as T
  }

  /** Like `call`, for functions that return an element; gives its object id. */
  private async element(
    frame: FrameTarget,
    contextId: number,
    fn: string,
    args: unknown[]
  ): Promise<string | undefined> {
    const response = await this.send<RemoteResult>(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: fn,
        executionContextId: contextId,
        arguments: args.map((value) => ({ value })),
        returnByValue: false
      },
      frame.sessionId
    )
    valueOf(response)
    return response.result.objectId
  }

  private release(frame: FrameTarget, objectId: string): void {
    this.send('Runtime.releaseObject', { objectId }, frame.sessionId).catch(() => undefined)
  }

  /** The page as an ARIA tree with refs, iframes included. */
  async snapshot(): Promise<string> {
    await this.attach()
    this.frames = new Map()
    const tree = await this.frameSnapshot(await this.mainFrame(), '', Date.now() + FRAMES_TIMEOUT)
    return compact(tree)
  }

  private async frameSnapshot(
    frame: FrameTarget,
    refPrefix: string,
    deadline: number
  ): Promise<string> {
    const contextId = await this.context(frame)
    const { full, iframeRefs } = await this.call<{ full: string; iframeRefs: string[] }>(
      frame,
      { contextId },
      SNAPSHOT,
      [refPrefix]
    )
    if (!iframeRefs.length) return full
    const children = new Map(
      await Promise.all(
        iframeRefs.map(
          async (ref) => [ref, await this.iframeSnapshot(frame, contextId, ref, deadline)] as const
        )
      )
    )
    // Each iframe's content goes under its line, as in Playwright.
    return full
      .split('\n')
      .flatMap((line) => {
        const ref = /^\s*- iframe (?:\[active\] )?\[ref=([^\]]+)\]/.exec(line)?.[1]
        const child = ref && children.get(ref)
        if (!child) return [line]
        const indent = `${/^\s*/.exec(line)![0]}  `
        return [`${line}:`, ...child.split('\n').map((childLine) => indent + childLine)]
      })
      .join('\n')
  }

  /** An iframe's content, or nothing if it cannot be read in the time left. */
  private async iframeSnapshot(
    parent: FrameTarget,
    parentContext: number,
    ref: string,
    deadline: number
  ): Promise<string | undefined> {
    const read = async (): Promise<string | undefined> => {
      const objectId = await this.element(parent, parentContext, ELEMENT, [ref])
      if (!objectId) return undefined
      const { node } = await this.send<{ node: { frameId?: string } }>(
        'DOM.describeNode',
        { objectId },
        parent.sessionId
      ).finally(() => this.release(parent, objectId))
      if (!node.frameId) return undefined
      const frame: FrameTarget = {
        frameId: node.frameId,
        sessionId: this.frameSessions.get(node.frameId) ?? parent.sessionId,
        parent
      }
      let number = this.frameNumbers.get(frame.frameId)
      if (!number) {
        number = this.frameNumbers.size + 1
        this.frameNumbers.set(frame.frameId, number)
      }
      this.frames.set(number, frame)
      return this.frameSnapshot(frame, `f${number}`, deadline)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    return withTimeout(read(), remaining, () => new Error('iframe took too long')).catch(
      () => undefined
    )
  }

  /** The frame a ref is in: the page itself, or the iframe numbered n for fn refs. */
  private async frameOf(ref: string): Promise<FrameTarget> {
    const match = /^(?:f(\d+))?e\d+$/.exec(ref)
    if (!match) {
      throw new Error(
        `"${ref}" is not a ref. Refs come from the snapshot and look like e12 or f1e3.`
      )
    }
    await this.attach()
    if (!match[1]) return this.mainFrame()
    const frame = this.frames.get(Number(match[1]))
    if (!frame) throw new Error(staleRef(ref))
    return frame
  }

  /**
   * Try an action on an element until it is ready (Playwright's actionability
   * checks), or fail with the reason it never was.
   */
  private async retry<T>(
    ref: string,
    action: string,
    attempt: (frame: FrameTarget, contextId: number, n: number) => Promise<Attempt<T>>
  ): Promise<T> {
    const frame = await this.frameOf(ref)
    const deadline = Date.now() + ACTION_TIMEOUT
    for (let n = 0; ; n++) {
      const result = await attempt(frame, await this.context(frame), n)
      if ('done' in result) return result.done
      if (result.problem === 'missing') throw new Error(staleRef(ref))
      if (Date.now() >= deadline) {
        const reason = PROBLEMS[result.problem]?.(result.by) ?? result.problem
        throw new Error(`Could not ${action} ${ref}: it ${reason}.`)
      }
      await sleep(100)
    }
  }

  /**
   * Where to point at an element, once it is ready for the action and on top:
   * in its frame's viewport, and in the page's (where input events go).
   */
  private target(
    ref: string,
    action: 'click' | 'hover'
  ): Promise<{ frame: FrameTarget; local: Point; page: Point }> {
    return this.retry<{ frame: FrameTarget; local: Point; page: Point }>(
      ref,
      action,
      async (frame, contextId, n) => {
        const probe = await this.call<Point & { problem?: string; by?: string }>(
          frame,
          { contextId },
          PROBE,
          [
            ref,
            {
              states: action === 'click' ? ['visible', 'enabled'] : ['visible'],
              stable: true,
              onTop: true,
              align: ALIGNMENTS[n % ALIGNMENTS.length]
            }
          ]
        )
        if (probe.problem) return { problem: probe.problem, by: probe.by }
        const page = await this.inPage(frame, probe, true)
        if (page.coveredBy) return { problem: 'covered', by: page.coveredBy }
        return { done: { frame, local: { x: probe.x, y: probe.y }, page } }
      }
    )
  }

  /**
   * A point in a frame's viewport, in the page's viewport, where input events
   * go. With `onTop`, also checks that nothing covers the iframes on the way.
   */
  private async inPage(
    frame: FrameTarget,
    point: Point,
    onTop: boolean
  ): Promise<Point & { coveredBy?: string }> {
    let { x, y } = point
    for (let child = frame; child.parent; child = child.parent) {
      const parent = child.parent
      const { backendNodeId } = await this.send<{ backendNodeId: number }>(
        'DOM.getFrameOwner',
        { frameId: child.frameId },
        parent.sessionId
      )
      const { object } = await this.send<{ object: { objectId: string } }>(
        'DOM.resolveNode',
        { backendNodeId, executionContextId: await this.context(parent) },
        parent.sessionId
      )
      try {
        const mapped = await this.call<Point & { coveredBy?: string }>(
          parent,
          { objectId: object.objectId },
          FRAME_POINT,
          [x, y, onTop]
        )
        if (mapped.coveredBy) return mapped
        ;({ x, y } = mapped)
      } finally {
        this.release(parent, object.objectId)
      }
    }
    return { x, y }
  }

  private mouse(type: string, { x, y }: Point, extra: object = {}): Promise<unknown> {
    return this.send('Input.dispatchMouseEvent', { type, x, y, ...extra })
  }

  async click(ref: string): Promise<void> {
    const { frame, local, page } = await this.target(ref, 'click')
    if (this.onScreen()) {
      await this.mouse('mouseMoved', page)
      await this.mouse('mousePressed', page, { button: 'left', clickCount: 1 })
      await this.mouse('mouseReleased', page, { button: 'left', clickCount: 1 })
      return
    }
    const clicked = await this.call<boolean>(
      frame,
      { contextId: await this.context(frame) },
      CLICK_IN_PAGE,
      [ref, local.x, local.y],
      true
    )
    if (!clicked) throw new Error(staleRef(ref))
  }

  async hover(ref: string): Promise<void> {
    // Mouse moves reach pages that are not on screen too.
    await this.mouse('mouseMoved', (await this.target(ref, 'hover')).page)
  }

  /**
   * Press a key in a page that is not on screen (see `onScreen`), on its
   * focused element. Characters are typed with the key.
   */
  async pressInPage(key: string, modifiers: string[]): Promise<void> {
    await this.attach()
    const frame = await this.mainFrame()
    const contextId = await this.context(frame)
    const allowed = await this.call<boolean>(
      frame,
      { contextId },
      KEY_IN_PAGE,
      [key, modifiers],
      true
    )
    if (allowed && key.length === 1 && modifiers.every((m) => m === 'shift')) {
      await this.send('Input.insertText', { text: key })
    }
  }

  /** Replace a field's content with text, like Playwright's fill. */
  async fill(ref: string, text: string): Promise<void> {
    const filled = await this.retry(ref, 'type into', async (frame, contextId) => {
      const result = await this.call<{ filled?: string; problem?: string }>(
        frame,
        { contextId },
        FILL,
        [ref, text]
      )
      return result.problem ? { problem: result.problem } : { done: result.filled }
    })
    if (filled === 'error:notconnected') throw new Error(staleRef(ref))
    if (filled !== 'needsinput') return
    // The field's text is selected; typing replaces it.
    if (text) {
      await this.send('Input.insertText', { text })
    } else {
      const del = { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...del })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...del })
    }
  }

  /** Choose options of a <select> by value or label; returns the selected values. */
  select(ref: string, values: string[]): Promise<string[]> {
    return this.retry<string[]>(ref, 'select in', async (frame, contextId) => {
      const result = await this.call<{ selected?: string[]; problem?: string; options?: string[] }>(
        frame,
        { contextId },
        SELECT,
        [ref, values]
      )
      if (result.options) {
        const options = result.options.map((o) => JSON.stringify(o)).join(', ')
        throw new Error(
          result.problem === 'optionnotenabled'
            ? `That option is disabled. Options: ${options}`
            : `No option matches ${JSON.stringify(values)}. Options: ${options}`
        )
      }
      return result.problem ? { problem: result.problem } : { done: result.selected! }
    })
  }

  /**
   * Scroll the area containing an element, or the middle of the page, by
   * pixels: inner panes too, not only the page. Returns what moved and how far.
   */
  async scroll(pixels: number, ref?: string): Promise<{ moved: number; area: string }> {
    type Scrolled = Attempt<{ moved: number; area: string }>
    if (ref) {
      return this.retry(ref, 'scroll at', (frame, contextId) =>
        this.call<Scrolled>(frame, { contextId }, SCROLL, [ref, pixels])
      )
    }
    await this.attach()
    const frame = await this.mainFrame()
    const result = await this.call<Scrolled>(
      frame,
      { contextId: await this.context(frame) },
      SCROLL,
      [null, pixels]
    )
    if (!('done' in result)) throw new Error('Nothing to scroll on this page.')
    return result.done
  }

  /**
   * PNG of the page's viewport, as base64. Electron renders a page for the
   * capture, so this works for pages of background chats too, which draw
   * nothing while parked off-screen.
   */
  async screenshot(): Promise<string> {
    const capture = (): Promise<Electron.NativeImage> =>
      withTimeout(
        this.contents.capturePage(),
        COMMAND_TIMEOUT,
        () => new Error(`The page did not render within ${COMMAND_TIMEOUT / 1000}s.`)
      )
    // Chromium fails a capture with UnknownVizError until the page's surface
    // exists; the same capture works moments later (as ZCode found).
    const deadline = Date.now() + 2000
    for (;;) {
      try {
        const image = await capture()
        if (image.isEmpty()) throw new Error('The page has not drawn anything yet.')
        return image.toPNG().toString('base64')
      } catch (error) {
        if (!/UnknownVizError/.test((error as Error).message) || Date.now() > deadline) throw error
        await sleep(100)
      }
    }
  }

  /** Run an expression in the page's own context and return its JSON value. */
  async evaluate(expression: string, timeout = COMMAND_TIMEOUT): Promise<unknown> {
    await this.attach()
    try {
      return valueOf(
        await this.send<RemoteResult>(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout },
          undefined,
          timeout + 1000
        )
      )
    } catch (error) {
      // Stop a script that is still running, such as an endless loop.
      this.send('Runtime.terminateExecution').catch(() => undefined)
      throw error
    }
  }

  /**
   * Put files into a page's upload control without the macOS file picker, which
   * an agent cannot operate. The picker the agent's click opens is intercepted
   * and answered with the files; interception is switched off right after, so
   * the user's own clicks open the normal picker.
   */
  async upload(ref: string, files: string[]): Promise<void> {
    const frame = await this.frameOf(ref)
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true }, frame.sessionId)
    try {
      const opened = this.nextEvent<{ backendNodeId?: number }>(
        'Page.fileChooserOpened',
        frame.sessionId,
        3000
      )
      const clicked = await this.click(ref).then(
        () => true,
        () => false
      )
      const chooser = clicked ? await opened : undefined
      if (chooser?.backendNodeId) {
        await this.send(
          'DOM.setFileInputFiles',
          { files, backendNodeId: chooser.backendNodeId },
          frame.sessionId
        )
        return
      }
      // No picker opened: the ref is the file field itself, or sits next to one.
      const input = await this.element(frame, await this.context(frame), FILE_INPUT, [ref])
      if (!input)
        throw new Error(`No file upload field found at ${ref}. Pass the ref of the upload button.`)
      try {
        await this.send('DOM.setFileInputFiles', { files, objectId: input }, frame.sessionId)
      } finally {
        this.release(frame, input)
      }
    } finally {
      await this.send(
        'Page.setInterceptFileChooserDialog',
        { enabled: false },
        frame.sessionId
      ).catch(() => undefined)
    }
  }
}

/**
 * Leave out what tells an agent nothing, as ZCode does: unnamed wrapper
 * elements (their content moves up a level) and unnamed images. Then cap the
 * length.
 */
function compact(snapshot: string): string {
  const lines: string[] = []
  /** Indents of the enclosing lines, and whether each was left out. */
  const open: { indent: number; dropped: boolean }[] = []
  for (const line of snapshot.split('\n')) {
    const item = line.trimStart()
    const indent = line.length - item.length
    while (open.length && open[open.length - 1].indent >= indent) open.pop()
    const dropped =
      /^- (?:generic|group|listitem)(?: \[ref=[^\]]+\])?:?$/.test(item) ||
      /^- img(?: \[ref=[^\]]+\])?$/.test(item)
    const droppedAbove = open.filter((o) => o.dropped).length
    open.push({ indent, dropped })
    if (!dropped) lines.push(' '.repeat(Math.max(0, indent - 2 * droppedAbove)) + item)
  }
  const text = lines.join('\n')
  if (text.length <= MAX_SNAPSHOT) return text
  const cut = text.lastIndexOf('\n', MAX_SNAPSHOT)
  return `${text.slice(0, cut)}\n[Snapshot cut at ${cut} of ${text.length} characters. Use evaluate to read a specific part of the page.]`
}
