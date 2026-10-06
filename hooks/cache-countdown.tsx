/**
 * cache-countdown: the wiring. turn.step records each main-loop request and
 * builds the view the band and the pane draw from, once per request; one
 * self-scheduling clock.after timer then carries only the time left, waking
 * when the countdown text changes or a toast is due, and not at all once the
 * cache has expired or caching is off. /cache opens the detail pane, /cache
 * setup the walkthrough (setup.ts holds its pure half).
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { CacheSample, CacheView, SetupChange, SetupDraft } from '../types'
import {
  accountKind,
  advise,
  baseLifetime,
  buildView,
  cachingOff,
  contextToast,
  countdownText,
  crossLevels,
  effectiveLifetime,
  expiryToast,
  formatCount,
  marksBehind,
  nextDelay,
  observe,
  readConfig,
  remainingMs,
  splitCells,
  statusText,
  takeMarks,
  textBar,
} from './cache'
import type { Account, AdviceState, Config, Lifetime } from './cache'
import { CUSTOM, FIELDS, PRESETS, REVIEW_STEP, STEP_COUNT, changes, display, draftFromOptions, encode, isListed } from './setup'
import type { Field } from './setup'

const PANE = 'cache'
const SETUP = 'cache-setup'
const MAX_SAMPLES = 200

const TICK = { plugin: 'cache-countdown', key: 'tick' } as const
const samplesAtom = atom({ plugin: 'cache-countdown', key: 'samples' } as const, [])
const viewAtom = atom({ plugin: 'cache-countdown', key: 'view' } as const, null)
const tickAtom = atom(TICK, 0)
const observedAtom = atom({ plugin: 'cache-countdown', key: 'observed' } as const, null)
const alertsAtom = atom({ plugin: 'cache-countdown', key: 'alerts' } as const, [])
const paneAtom = atom({ plugin: 'cache-countdown', key: 'paneOpen' } as const, false)
const draftAtom = atom({ plugin: 'cache-countdown', key: 'draft' } as const, null)
const noteAtom = atom({ plugin: 'cache-countdown', key: 'setupNote' } as const, '')
const pendingAtom = atom({ plugin: 'cache-countdown', key: 'pending' } as const, [])
const stepAtom = atom({ plugin: 'cache-countdown', key: 'setupStep' } as const, 0)

// ---------------------------------------------------------------- module state (starts over on every load)

/** the options as stored (the walkthrough compares against these) */
let current: Readonly<Record<string, unknown>> = {}
/** the options, checked and parsed */
let cfg: Config = readConfig({})

type Environment = { ttl?: string; force5m?: string; enable1h?: string; off: { all?: string; haiku?: string; sonnet?: string; opus?: string } }
let env: Environment = { off: {} }
let settingTtl: unknown
let account: Account = 'other'
let contextWindow = 0

let timer: ReturnType<EngineInterface['clock']['after']> | null = null
let busy = false
let again = false
/** bumped by every stop, so a wake already under way does not schedule another */
let epoch = 0
/** how many of cfg.marks the current countdown has used up */
let shown = 0
let lastStatus: string | undefined
let paneShown = false

// ---------------------------------------------------------------- reading the world

async function readEnvironment($: EngineInterface) {
  const [ttl, force5m, enable1h, all, haiku, sonnet, opus] = await Promise.all([
    $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    $.env.get('FORCE_PROMPT_CACHING_5M'),
    $.env.get('ENABLE_PROMPT_CACHING_1H'),
    $.env.get('DISABLE_PROMPT_CACHING'),
    $.env.get('DISABLE_PROMPT_CACHING_HAIKU'),
    $.env.get('DISABLE_PROMPT_CACHING_SONNET'),
    $.env.get('DISABLE_PROMPT_CACHING_OPUS'),
  ])
  env = { ttl, force5m, enable1h, off: { all, haiku, sonnet, opus } }
  const merged = await $.settings.read().catch(() => ({}) as Readonly<Record<string, unknown>>)
  settingTtl = merged.promptCacheTtl
}

async function refreshUsage($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    contextWindow = usage.context && usage.context.window > 0 ? usage.context.window : 0
    account = accountKind(usage.rateLimits ?? [])
  } catch {
    // keep the last reading
  }
}

const baseNow = (): Lifetime =>
  baseLifetime({ option: cfg.ttl, force5m: env.force5m, envTtl: env.ttl, settingTtl, enable1h: env.enable1h, account })

/** Rebuilds the view from the kept samples and stores it: once per request, at load and on /clear. */
async function rebuild($: EngineInterface): Promise<CacheView> {
  const samples = await read($, samplesAtom)
  const lifetime = effectiveLifetime(baseNow(), await read($, observedAtom))
  const view = buildView({ samples, lifetime, off: cachingOff(env.off, samples.at(-1)?.model), window: contextWindow })
  await update($, viewAtom, () => view)
  return view
}

// ---------------------------------------------------------------- per request

async function recordStep($: EngineInterface, turnId: string, model: string, at: number, usage: TurnUsage) {
  const samples = await read($, samplesAtom)
  const prev = samples.at(-1)
  const sample: CacheSample = {
    at,
    turnId,
    turnNo: prev ? (prev.turnId === turnId ? prev.turnNo : prev.turnNo + 1) : 1,
    model: usage.model || model,
    read: usage.cache_read_input_tokens ?? 0,
    write: usage.cache_creation_input_tokens ?? 0,
    fresh: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  }
  await update($, samplesAtom, list => [...list, sample].slice(-MAX_SAMPLES))
  await refreshUsage($)
  if (!baseNow().pinned) {
    const before = await read($, observedAtom)
    const after = observe(before, prev, sample)
    if (after !== before) await update($, observedAtom, () => after)
  }
  const view = await rebuild($)
  await checkContext($, view)
  $.ui.log(
    `step read=${sample.read} write=${sample.write} new=${sample.fresh} model=${sample.model} ttl=${view.ttlLabel} source=${view.source} window=${contextWindow || 'unknown'}`,
    { to: 'debug' },
  )
  await restartCountdown($, view)
}

async function checkContext($: EngineInterface, view: CacheView) {
  if (!view.last || view.windowLeft === null || cfg.levels.length === 0) return
  const before = await read($, alertsAtom)
  const { announce, announced } = crossLevels(cfg.levels, before, view.windowLeft)
  if (announced.join() !== before.join()) await update($, alertsAtom, () => announced)
  if (announce !== undefined) $.ui.toast(contextToast(view.windowLeft, view.last.prompt, view.window, cfg.compactWhenRemainingPct))
}

// ---------------------------------------------------------------- the timer

function stopTimer() {
  epoch++
  again = false
  timer?.cancel()
  timer = null
}

const isLive = (view: CacheView | null): view is CacheView & { last: NonNullable<CacheView['last']> } =>
  !!view && !!view.last && !view.off && !view.last.uncached

/** A new countdown (a request arrived, or the module loaded): every mark still ahead is armed again. */
async function restartCountdown($: EngineInterface, view: CacheView) {
  stopTimer()
  if (!isLive(view)) {
    await setStatus($, statusText(view, 0, cfg))
    return
  }
  shown = marksBehind(cfg.marks, remainingMs(view.last.at, view.ttl, await $.clock.now()))
  await tick($)
}

/** One wake at a time; a wake asked for during one runs once right after it. */
async function tick($: EngineInterface) {
  if (busy) {
    again = true
    return
  }
  busy = true
  try {
    do {
      again = false
      timer?.cancel()
      timer = null
      const mine = epoch
      const delay = await wake($)
      if (!again && delay !== null && mine === epoch) timer = $.clock.after(delay, () => void tick($))
    } while (again)
  } finally {
    busy = false
  }
}

/** What one wake does: the toast due, the time left for the band and pane, the footer line; then how long to sleep. */
async function wake($: EngineInterface): Promise<number | null> {
  const view = await read($, viewAtom)
  if (!isLive(view)) {
    await setStatus($, statusText(view, 0, cfg))
    return null
  }
  const left = remainingMs(view.last.at, view.ttl, await $.clock.now())
  if (cfg.toast) {
    const due = takeMarks(cfg.marks, shown, left)
    shown = due.shown
    if (due.fire !== undefined) $.ui.toast(expiryToast(due.fire, view.last.prompt))
  }
  if (cfg.band || paneShown) await $.state.set(TICK, left)
  await setStatus($, statusText(view, left, cfg))
  // nothing to draw and nothing to announce: sleep until a request or /cache asks again
  if (!cfg.toast && !cfg.status && !cfg.band && !paneShown) return null
  return nextDelay(left, cfg, cfg.toast ? cfg.marks : [], shown)
}

async function setStatus($: EngineInterface, text: string | undefined) {
  if (!cfg.status || text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

// ---------------------------------------------------------------- session

async function startSession($: EngineInterface) {
  stopTimer()
  shown = 0
  lastStatus = undefined
  await readEnvironment($)
  await refreshUsage($)
  await $.command.register({
    name: 'cache',
    description: 'Prompt cache meter: countdown, last request, per-turn table',
    argumentHint: '[setup|stop]',
    immediate: true,
  })
  paneShown = await read($, paneAtom)
  const view = await rebuild($)
  const off = view.off ? `, prompt caching is off (${view.off})` : ''
  $.ui.log(`cache-countdown loaded: ${view.ttlLabel} cache (${view.source})${off}, /cache opens the pane`, { to: 'debug' })
  await applyPending($)
  await firstRun($)
  await restartCountdown($, view)
}

async function firstRun($: EngineInterface) {
  const seen = await $.store.get('setupSeen').catch(() => true)
  if (seen) return
  $.ui.toast('cache-countdown is on: /cache setup walks through its settings')
  await $.store.set('setupSeen', true).catch(() => undefined)
}

async function clearSession($: EngineInterface) {
  stopTimer()
  shown = 0
  await update($, samplesAtom, () => [])
  await update($, observedAtom, () => null)
  await update($, alertsAtom, () => [])
  await rebuild($)
  if (cfg.status || lastStatus !== undefined) $.ui.status(undefined)
  lastStatus = undefined
}

// ---------------------------------------------------------------- /cache

async function setPane($: EngineInterface, open: boolean) {
  paneShown = open
  if ((await read($, paneAtom)) !== open) await update($, paneAtom, () => open)
}

async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE }).catch(() => undefined)
  await setPane($, false)
}

async function openPane($: EngineInterface): Promise<string> {
  await $.ui.open({ id: PANE, title: 'cache', columns: 64, rows: 24, focus: true, closeOnEscape: true })
  await setPane($, true)
  const view = await read($, viewAtom)
  const left = view?.last ? remainingMs(view.last.at, view.ttl, await $.clock.now()) : 0
  // the pane draws from the tick: a live countdown wakes now (and writes it), anything else writes it once
  if (isLive(view) && left > 0) await tick($)
  else await $.state.set(TICK, left)
  if (!view) return 'cache: not read yet · /cache stop closes'
  return `${view.ttlLabel} cache (${view.source}) · ${advise(view, left, cfg).text} · /cache stop closes`
}

async function runCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const word = args.trim().toLowerCase()
  if (word === 'setup') {
    await openSetup($)
    return { text: 'cache setup opened: start from a preset, adjust each setting, then Save' }
  }
  if (word === 'stop') {
    await closePane($)
    return { text: 'cache pane closed' }
  }
  return { text: await openPane($) }
}

// ---------------------------------------------------------------- drawing helpers

const STATE_COLOR: Record<AdviceState, string> = {
  off: 'gray',
  cold: 'gray',
  uncached: 'gray',
  expired: 'red',
  soon: 'red',
  miss: 'yellow',
  warm: 'green',
}

/** green while plenty is left, yellow in the last third, red in the final stretch */
function clockColor(left: number, ttl: number): string {
  if (left <= cfg.warnSeconds * 1000) return 'red'
  return left <= (ttl * 1000) / 3 ? 'yellow' : 'green'
}

/** what the setup walkthrough shows as "Detected now" */
async function snapshot($: EngineInterface, now: number) {
  const view = await read($, viewAtom)
  const left = view?.last ? remainingMs(view.last.at, view.ttl, now) : 0
  return {
    ttl: view ? (view.off ? 'off' : view.ttlLabel) : 'unknown',
    source: view ? (view.off ?? view.source) : 'not read yet',
    left,
  }
}

// ---------------------------------------------------------------- setup walkthrough: actions

/**
 * One config.set per option, each with its key spelled out, so anyone reading the
 * source (the plugin directory's scan included) can see exactly which settings it
 * can write: this plugin's own options under pluginConfigs, nothing else.
 */
async function writeSetting($: EngineInterface, change: SetupChange): Promise<{ deny?: string }> {
  const value = change.value
  switch (change.key) {
    case 'ttl': return $.config.set({ key: 'cache-countdown.ttl', value: value })
    case 'tickSeconds': return $.config.set({ key: 'cache-countdown.tickSeconds', value: value })
    case 'warnSeconds': return $.config.set({ key: 'cache-countdown.warnSeconds', value: value })
    case 'finalTickSeconds': return $.config.set({ key: 'cache-countdown.finalTickSeconds', value: value })
    case 'toast': return $.config.set({ key: 'cache-countdown.toast', value: value })
    case 'toastAt': return $.config.set({ key: 'cache-countdown.toastAt', value: value })
    case 'contextAlertsAt': return $.config.set({ key: 'cache-countdown.contextAlertsAt', value: value })
    case 'compactWhenRemainingPct': return $.config.set({ key: 'cache-countdown.compactWhenRemainingPct', value: value })
    case 'band': return $.config.set({ key: 'cache-countdown.band', value: value })
    case 'status': return $.config.set({ key: 'cache-countdown.status', value: value })
    default: return { deny: 'not an option of this plugin' }
  }
}

/**
 * Writes the wizard's queued settings. Each write reloads the mod, which can end
 * this environment mid-loop, so the queue lives in $.state: an item is taken off
 * before it is written, and the next load's session.start carries on.
 */
async function applyPending($: EngineInterface) {
  for (;;) {
    const queue = (await read($, pendingAtom)) as SetupChange[]
    const head = queue[0]
    if (!head) return
    await update($, pendingAtom, q => (q as SetupChange[]).slice(1))
    const r = await writeSetting($, head).catch((err: unknown) => ({ deny: String(err) }))
    const line = r.deny ? `${head.key} not saved (${r.deny})` : `${head.key} = ${encode(head.value)}`
    await update($, noteAtom, note => (note ? `${note} · ${line}` : line))
    if (queue.length === 1) $.ui.toast(`cache-countdown settings: ${(await read($, noteAtom)) as string}`)
  }
}

async function openSetup($: EngineInterface) {
  await update($, draftAtom, () => draftFromOptions(current))
  await update($, noteAtom, () => '')
  await update($, stepAtom, () => 0)
  await $.ui.open({ id: SETUP, title: 'cache setup', focus: true, closeOnEscape: true, columns: 76, rows: 22 })
  await $.store.set('setupSeen', true).catch(() => undefined)
}

async function saveSetup($: EngineInterface) {
  await commitTyping($)
  const draft = ((await read($, draftAtom)) as SetupDraft | null) ?? draftFromOptions(current)
  const todo = changes(draft, current)
  await $.ui.close({ id: SETUP }).catch(() => undefined)
  await update($, draftAtom, () => null)
  if (todo.length === 0) {
    $.ui.toast('cache-countdown: nothing changed')
    return
  }
  await update($, noteAtom, () => '')
  await update($, pendingAtom, () => todo)
  await applyPending($)
}

async function pickSetup($: EngineInterface, key: string, value: string | number | boolean) {
  await update($, draftAtom, d => ({ ...((d as SetupDraft | null) ?? draftFromOptions(current)), [key]: value }))
}

/** custom…: mark the step custom and put the keyboard in its text field (focus waits for the field to be drawn) */
async function startCustom($: EngineInterface, key: string) {
  await update($, draftAtom, d => ({ ...((d as SetupDraft | null) ?? draftFromOptions(current)), [`${key}:custom`]: true }))
  await $.ui.focus({ requestId: SETUP, key: `in:${key}` }).catch(() => undefined)
}

// text typed into a custom field and not yet committed: held here so typing never redraws (a redraw per key resets the field)
const typing = new Map<string, string>()

/** Commit a custom field's text: the raw text for the field, and the cleaned value when it is valid. */
async function typeCustom($: EngineInterface, key: string, raw: string) {
  typing.delete(key)
  const clean = FIELDS.find(f => f.key === key)?.custom?.normalize(raw)
  await update($, draftAtom, d => ({
    ...((d as SetupDraft | null) ?? draftFromOptions(current)),
    [`${key}:text`]: raw,
    [`${key}:custom`]: true,
    ...(clean !== undefined ? { [key]: clean } : {}),
  }))
}

/** Before leaving a step (Next, Back, review, Save): commit whatever is still being typed. */
async function commitTyping($: EngineInterface) {
  for (const [key, raw] of [...typing]) await typeCustom($, key, raw)
}

async function gotoStep($: EngineInterface, step: number) {
  await commitTyping($)
  await update($, stepAtom, () => Math.max(0, Math.min(REVIEW_STEP, step)))
}

async function presetSetup($: EngineInterface, draft: SetupDraft) {
  await update($, draftAtom, () => ({ ...draft }))
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  current = options
  cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startSession($)
    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await clearSession($)
      } catch (err) {
        $.ui.log(`cache-countdown: reset after /clear failed (${String(err)})`, { to: 'debug' })
      }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // subagents have cache prefixes of their own: their requests say nothing about this one
    if (e.agentId) return yield* next(e)
    const at = await $.clock.now()
    const result = yield* next(e)
    if (result.usage) {
      try {
        await recordStep($, e.turnId, e.model, at, result.usage)
      } catch (err) {
        $.ui.log(`cache-countdown: could not record a request (${String(err)})`, { to: 'debug' })
      }
    }
    return result
  })

  on('command.run', { command: 'cache' }, async ($, e) => runCommand($, e.args))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await setPane($, false).catch(() => undefined)
    return closed
  })

  // the meter row above the input box
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg.band || e.props.hasSurvey) return next(e)
    const view = await read($, viewAtom)
    if (!view) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (view.off && !view.last) {
      return (
        <Box flexDirection="row">
          <Text dimColor wrap="truncate-end">{`cache · ${advise(view, 0, cfg).text}`}</Text>
        </Box>
      )
    }
    if (await read($, paneAtom)) return next(e)
    const last = view.last
    if (!last) return next(e)
    const left = await read($, tickAtom)
    const advice = advise(view, left, cfg)
    const wide = e.props.bodyColumns >= 90
    const timed = advice.state !== 'off' && advice.state !== 'uncached'
    // the figures never shrink or wrap; only the advice tail gives way on a narrow body
    return (
      <Box flexDirection="row" columnGap={1}>
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Text color={STATE_COLOR[advice.state]}>●</Text>
          <Text bold color="cyan">cache</Text>
          <Text color={STATE_COLOR[advice.state]}>{textBar(last.hit / 100, wide ? 10 : 6)}</Text>
          <Text bold>{`${last.hit}%`}</Text>
          {wide ? <Text color="green">{`read ${formatCount(last.read)}`}</Text> : <Text dimColor>{`prompt ${formatCount(last.prompt)}`}</Text>}
          {wide ? <Text color="yellow">{`wrote ${formatCount(last.write)}`}</Text> : null}
          {wide ? <Text color="blue">{`new ${formatCount(last.fresh)}`}</Text> : null}
          {timed ? <Text bold color={clockColor(left, view.ttl)}>{`⏱ ${countdownText(left, cfg)}`}</Text> : null}
        </Box>
        <Text dimColor wrap="truncate-end">{view.off ? advice.text : `${view.ttlLabel} · ${advice.text}`}</Text>
      </Box>
    )
  })

  // the /cache pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = await read($, viewAtom)
    const left = await read($, tickAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    // remote surfaces collapse runs of spaces; no-break spaces keep aligned text aligned
    const aligned = (text: string) => (e.surface === 'terminal' ? text : text.replace(/ /g, ' '))
    const width = Math.max(32, Math.min(e.props.bodyColumns || 64, 80))
    const close = <Button key="close" label="close" role="dismiss" onPress={() => void closePane($)} />
    if (!view) {
      return (
        <Box flexDirection="column">
          <Text bold color="cyan">PROMPT CACHE</Text>
          <Text dimColor>not read yet</Text>
          {close}
        </Box>
      )
    }
    const advice = advise(view, left, cfg)
    const last = view.last
    const ttlMs = view.ttl * 1000
    const lifeCells = Math.max(10, width - 24)
    const barCells = Math.max(10, width - 2)
    const parts = last ? splitCells([last.read, last.write, last.fresh], barCells) : []
    const colors = ['green', 'yellow', 'blue']
    const room = Math.max(1, (e.props.scroll?.bodyRows ?? 24) - 15)
    const rows = view.rows.slice(-room)
    const COLS = [6, 7, 9, 9, 9, 6]
    const cells = (key: string, values: string[], bold?: boolean) => (
      <Box key={key} flexDirection="row">
        {values.map((v, i) => (
          <Box key={`${key}:${i}`} width={COLS[i] ?? 8} justifyContent={i === 0 ? 'flex-start' : 'flex-end'}>
            <Text bold={bold}>{v}</Text>
          </Box>
        ))}
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Box key="title" flexDirection="column">
          <Text bold color="cyan">PROMPT CACHE</Text>
          <Text dimColor wrap="wrap">{view.off ? `off · ${view.off}` : `${view.ttlLabel} lifetime · ${view.source}`}</Text>
        </Box>
        {isLive(view) ? (
          <Box key="life" flexDirection="row" columnGap={1} marginTop={1}>
            <Text color={clockColor(left, view.ttl)}>{left > 0 ? `⏱ ${countdownText(left, cfg)} left` : '⏱ expired'}</Text>
            <Text color={clockColor(left, view.ttl)}>{textBar(left / ttlMs, lifeCells)}</Text>
            <Text>{`${Math.round((100 * left) / ttlMs)}%`}</Text>
          </Box>
        ) : null}
        <Box key="advice" flexDirection="column" marginTop={isLive(view) ? 0 : 1}>
          <Text color={STATE_COLOR[advice.state]} wrap="wrap">{advice.text}</Text>
          <Text dimColor>{last ? `${last.model} · prompt ${formatCount(last.prompt)} tokens` : 'no request yet'}</Text>
        </Box>
        {last ? (
          <Box key="last" flexDirection="column" marginTop={1}>
            <Box flexDirection="row" justifyContent="space-between" width={barCells}>
              <Text bold>last request</Text>
              <Text>{`${last.hit}% hit`}</Text>
            </Box>
            <Box flexDirection="row">
              {parts.map((n, i) => (n > 0 ? <Box key={`seg:${i}`} width={n} height={1} backgroundColor={colors[i] ?? 'gray'} /> : null))}
            </Box>
            <Box flexDirection="row" columnGap={2}>
              <Text color="green">{`■ read ${formatCount(last.read)}`}</Text>
              <Text color="yellow">{`■ wrote ${formatCount(last.write)}`}</Text>
              <Text color="blue">{`■ new ${formatCount(last.fresh)}`}</Text>
            </Box>
          </Box>
        ) : null}
        {view.rows.length ? (
          <Box key="turns" flexDirection="column" marginTop={1}>
            {cells('head', ['turn', 'steps', 'read', 'wrote', 'new', 'hit'], true)}
            {rows.map(r =>
              cells(`turn:${r.label}`, [r.label, String(r.steps), formatCount(r.read), formatCount(r.write), formatCount(r.fresh), `${r.hit}%`]),
            )}
            {cells('all', [view.total.label, String(view.total.steps), formatCount(view.total.read), formatCount(view.total.write), formatCount(view.total.fresh), `${view.total.hit}%`], true)}
          </Box>
        ) : null}
        <Box key="foot" flexDirection="row" columnGap={2} marginTop={1}>
          {close}
          <Text dimColor>{aligned('Esc or /cache stop closes')}</Text>
        </Box>
      </Box>
    )
  })

  // the /cache setup walkthrough
  on('ui.render', { component: 'Pane', requestId: SETUP }, async ($, e) => {
    const draft = ((await read($, draftAtom)) as SetupDraft | null) ?? draftFromOptions(current)
    const step = Math.max(0, Math.min(REVIEW_STEP, (await read($, stepAtom)) as number))
    const s = await snapshot($, await $.clock.now())
    if (e.surface === 'mobile') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text bold>cache-countdown setup</Text>
          <Text dimColor>No pickers on this surface: use /config, or run /cache setup in the terminal or desktop app.</Text>
        </Box>
      )
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const terminal = e.surface === 'terminal'
    // breathing room everywhere but the terminal's inline pane, whose height Claude Code caps
    const gap = !terminal || e.props.placement === 'dock' ? 1 : 0
    const count = changes(draft, current).length
    const preset = PRESETS.find(p => FIELDS.every(f => encode(p.draft[f.key] ?? '') === encode(draft[f.key] ?? '')))

    // one choice: a button that is the click target, ● on the picked one in the accent colour, a dim hint beside it
    const option = (key: string, label: string, hint: string | undefined, picked: boolean, onPress: () => void) => (
      <Box key={`opt:${key}`} flexDirection="row" columnGap={1}>
        <Button key={`pick:${key}`} label={`${picked ? '●' : '○'} ${label}`} variant={picked ? 'primary' : undefined} onPress={onPress} />
        {hint ? <Text dimColor wrap="wrap">{hint}</Text> : null}
      </Box>
    )
    const heading = (title: string) => (
      <Box key="head" flexDirection="column">
        <Text dimColor>{`cache-countdown setup · step ${step + 1} of ${STEP_COUNT}`}</Text>
        <Text bold color="cyan">{title}</Text>
      </Box>
    )
    const help = (lines: string[]) => (
      <Box key="help" flexDirection="column" marginTop={gap}>
        {lines.map((line, i) => (
          <Text key={`help:${i}`} wrap="wrap">{line}</Text>
        ))}
      </Box>
    )
    const nav = (
      <Box key="nav" flexDirection="row" columnGap={2} marginTop={gap}>
        {step > 0 ? <Button key="back" label="Back" onPress={() => void gotoStep($, step - 1)} /> : null}
        {step < REVIEW_STEP ? (
          <Button key="next" label="Next" variant="primary" onPress={() => void gotoStep($, step + 1)} />
        ) : (
          <Button key="save" label={count ? `Save ${count} change${count === 1 ? '' : 's'}` : 'Save'} variant="primary" onPress={() => void saveSetup($)} />
        )}
        {step < REVIEW_STEP ? <Button key="review" label="Skip to review" onPress={() => void gotoStep($, REVIEW_STEP)} /> : null}
        <Button key="cancel" label="Cancel" role="dismiss" onPress={() => void $.ui.close({ id: SETUP })} />
      </Box>
    )

    if (step === 0) {
      return (
        <Box flexDirection="column">
          {heading('Start from a preset')}
          {help([
            'cache-countdown shows how much of each request Claude served from its prompt cache, and counts down to when that cache expires.',
            'Pick a starting point. The next steps explain each setting so you can adjust it, or skip straight to the review.',
          ])}
          <Box key="choices" flexDirection="column" marginTop={gap}>
            {PRESETS.map(p => option(`preset:${p.key}`, p.label, p.about, preset?.key === p.key, () => void presetSetup($, p.draft)))}
            {preset ? null : <Text key="own" dimColor>{'● your own picks (keep them, or choose a preset)'}</Text>}
          </Box>
          {nav}
        </Box>
      )
    }

    if (step === REVIEW_STEP) {
      return (
        <Box flexDirection="column">
          {heading('Review and save')}
          {help(['Click a row to change it. Save writes your Claude Code settings, like /config, and the mod reloads with them.'])}
          <Box key="rows" flexDirection="column" marginTop={gap}>
            {FIELDS.map((f, i) => {
              const changed = encode(draft[f.key] ?? '') !== encode(draftFromOptions(current)[f.key] ?? '')
              return (
                <Box key={`row:${f.key}`} flexDirection="row" columnGap={1}>
                  <Button key={`edit:${f.key}`} plain label={`${f.label}: ${display(f, draft[f.key])}`} onPress={() => void gotoStep($, i + 1)} />
                  {changed ? <Text color="yellow">changed</Text> : null}
                </Box>
              )
            })}
          </Box>
          {nav}
        </Box>
      )
    }

    const f = FIELDS[step - 1] as Field
    const value = draft[f.key]
    const customOn = draft[`${f.key}:custom`] === true || (f.custom !== undefined && value !== undefined && !isListed(f, value))
    const pick = (v: string | number | boolean) => {
      void update($, draftAtom, d => ({ ...((d as SetupDraft | null) ?? draftFromOptions(current)), [f.key]: v, [`${f.key}:custom`]: false }))
    }
    return (
      <Box flexDirection="column">
        {heading(f.title)}
        {help(f.key === 'ttl' ? [...f.help, `Detected now: ${s.ttl} (${s.source}).`] : f.help)}
        <Box key="choices" flexDirection="column" marginTop={gap}>
          {f.choices.map(c => option(`${f.key}:${encode(c.value)}`, c.label, c.hint, !customOn && encode(c.value) === encode(value ?? ''), () => pick(c.value)))}
          {f.custom ? option(`${f.key}:${CUSTOM}`, 'custom…', 'type your own below', customOn, () => void startCustom($, f.key)) : null}
          {f.custom ? (
            <Box key="custom-field" flexDirection="row" columnGap={1}>
              <Text dimColor>custom:</Text>
              <Input
                key={`in:${f.key}`}
                placeholder={f.custom.placeholder}
                value={typeof draft[`${f.key}:text`] === 'string' ? (draft[`${f.key}:text`] as string) : value !== undefined && !isListed(f, value) ? encode(value) : ''}
                submitLabel="use"
                onInput={raw => {
                  typing.set(f.key, raw)
                }}
                onSubmit={raw => void typeCustom($, f.key, raw)}
              />
            </Box>
          ) : null}
        </Box>
        {nav}
      </Box>
    )
  })
}
