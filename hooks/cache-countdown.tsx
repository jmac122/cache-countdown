/**
 * cache-countdown: a prompt-cache meter for Claude Code.
 *
 *   - turn.step: each main-loop request's usage (subagents skipped: own prefixes)
 *   - one self-scheduling $.clock.after timer, no fixed interval: it wakes only
 *     when the countdown text changes (every `tickSeconds`, default 60, then every
 *     `finalTickSeconds`, default 1, inside the last `warnSeconds`) or a toast is
 *     due. 1h cache on defaults: ~60 wakes in the last minute, one a minute before.
 *     It stops on expiry, no-cache or caching off, and restarts on the next request.
 *   - each tick writes one `tick` state value that only the band and the pane
 *     read, so a tick redraws those two sites and nothing else (no global
 *     ui.render invalidation, no transcript re-render)
 *   - ui.render: AbovePrompt band + the /cache Pane
 *   - samples and the observed TTL live in $.state, so a hot reload keeps them
 *
 * Options: ttl auto|5m|1h, warnSeconds, tickSeconds, finalTickSeconds, compactWhenRemainingPct,
 *          band, status, toast, toastAt, contextAlertsAt.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import {
  accountOf,
  contextAlert,
  parsePercents,
  remainingPct,
  DEFAULT_WINDOW,
  pctOption,
  usedAt,
  advise,
  bar,
  byTurn,
  decideTtl,
  fit,
  fmtClock,
  fmtCountdown,
  fmtSpan,
  fmtTokens,
  hitRatio,
  isCachingDisabled,
  lifeColor,
  lifeRatio,
  nextDelay,
  nextToastMark,
  parseMarks,
  observeTtl,
  positive,
  promptTokens,
  remainingMs,
  segments,
  totals,
  URGENT_SECS,
} from './cache'
import type { Advice, CacheEnv, Pace, Sample, TtlChoice, Ttl } from './cache'
import { changes, CUSTOM, decode, display, draftFromOptions, encode, FIELDS, isListed, PRESETS, REVIEW_STEP, STEP_COUNT } from './setup'
import type { Field } from './setup'
import type { SetupChange, SetupDraft } from './setup'

const PANE = 'cache'
const SETUP = 'cache-setup'
const COMMAND = 'cache'
const KEEP = 200

const samplesAtom = atom({ plugin: 'cache-countdown', key: 'samples' } as const, [])
const observedAtom = atom({ plugin: 'cache-countdown', key: 'observed' } as const, null)
const tickAtom = atom({ plugin: 'cache-countdown', key: 'tick' } as const, 0)
const paneAtom = atom({ plugin: 'cache-countdown', key: 'paneOpen' } as const, false)
const draftAtom = atom({ plugin: 'cache-countdown', key: 'draft' } as const, null)
const noteAtom = atom({ plugin: 'cache-countdown', key: 'setupNote' } as const, '')
const pendingAtom = atom({ plugin: 'cache-countdown', key: 'pending' } as const, [])
const stepAtom = atom({ plugin: 'cache-countdown', key: 'setupStep' } as const, 0)
const alertedAtom = atom({ plugin: 'cache-countdown', key: 'alerted' } as const, [])

const COLOR: Record<Advice['kind'], string | undefined> = {
  warm: 'green',
  soon: 'yellow',
  expired: 'red',
  miss: 'red',
  off: undefined,
  cold: undefined,
  uncached: undefined,
}
const ICON: Record<Advice['kind'], string> = { warm: '●', soon: '▲', expired: '✖', miss: '✖', off: '○', cold: '○', uncached: '○' }

const hitColor = (pct: number) => (pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red')

type Config = {
  warnMs: number
  pace: Pace
  toastAt: number[]
  /** context-window alert levels, % of the window remaining; [] = off */
  contextAlerts: number[]
  /** an expired cache suggests /compact once the window remaining is at or below this percentage */
  compactWhenRemainingPct: number
  showBand: boolean
  showStatus: boolean
  wantToast: boolean
  pinned: boolean
  ttlOption: unknown
}

// module state: rebuilt by register + session.start on every load, so a hot reload loses nothing that matters
let cfg: Config = {
  warnMs: 60_000,
  pace: { tickMs: 60_000, finalTickMs: 1_000, warnMs: 60_000 },
  toastAt: parseMarks(undefined),
  contextAlerts: [50, 25, 10],
  compactWhenRemainingPct: 60, showBand: true, showStatus: false, wantToast: true, pinned: false, ttlOption: 'auto' }
let env: CacheEnv = {}
let setting: unknown
let base: TtlChoice = decideTtl('auto', {})
let timer: Timer | undefined
let ticking = false
let rerun = false
let lastStatus: string | undefined
let toastedFor = 0
let toastLevel = Infinity
// the session model's context window, from the status line's figures; 0 until reported
let windowTokens = 0
// the options this load runs with: what settings hold, defaults filled in
let current: Readonly<Record<string, unknown>> = {}

type Snapshot = { samples: Sample[]; last: Sample | undefined; ttl: Ttl; source: string; advice: Advice; left: number }

async function snapshot($: EngineInterface, now: number): Promise<Snapshot> {
  const samples = (await read($, samplesAtom)) as Sample[]
  const observed = (await read($, observedAtom)) as Ttl | null
  const useObserved = !cfg.pinned && observed !== null
  const ttl: Ttl = useObserved ? observed : base.ttl
  const source = useObserved
    ? observed === base.ttl
      ? `${base.source}, confirmed by traffic`
      : `observed from request timing; ${base.source} said ${base.ttl}`
    : base.source
  const last = samples[samples.length - 1]
  const prev = samples[samples.length - 2]
  const disabled = isCachingDisabled(last?.model ?? '', env)
  const window = windowTokens || DEFAULT_WINDOW
  const compactAtTokens = usedAt(window, cfg.compactWhenRemainingPct)
  const advice = advise(last, prev, { ttl, warnMs: cfg.warnMs, compactAtTokens, windowTokens: windowTokens || undefined }, now, disabled)
  const left = last && !disabled ? remainingMs(last, ttl, now) : 0
  return { samples, last, ttl, source, advice, left }
}

function shortLine(s: Snapshot): string {
  if (!s.last || s.advice.kind === 'off') return `cache: ${s.advice.kind}`
  return `cache ${Math.round(hitRatio(s.last) * 100)}%${s.left > 0 ? ` · ${fmtCountdown(s.left, cfg.pace)}` : ' · expired'}`
}

function stopTimer() {
  timer?.cancel()
  timer = undefined
}

async function tick($: EngineInterface) {
  // a tick asked for while one runs runs once after it, never alongside
  if (ticking) {
    rerun = true
    return
  }
  ticking = true
  try {
    const now = await $.clock.now()
    const s = await snapshot($, now)
    const secs = Math.ceil(s.left / 1000)
    if (cfg.showBand || (await read($, paneAtom))) await update($, tickAtom, () => secs)
    if (cfg.showStatus) {
      const line = shortLine(s)
      if (line !== lastStatus) {
        lastStatus = line
        $.ui.status(line)
      }
    }
    // cache-expiry toasts are independent of the context window: they fire at the marks whenever toasts are on
    const toasting = cfg.wantToast && !!s.last && s.left > 0
    if (toasting && s.last) {
      if (toastedFor !== s.last.startedAt) {
        toastedFor = s.last.startedAt
        toastLevel = Infinity
      }
      const mark = nextToastMark(secs, cfg.toastAt, toastLevel)
      if (mark !== undefined) {
        toastLevel = mark
        const tail = secs <= URGENT_SECS ? 'send a message now' : `send a message to keep ${fmtTokens(promptTokens(s.last))} tokens warm`
        $.ui.toast(`cache expires in ${fmtSpan(secs)}: ${tail}`)
      }
    }
    // nothing left to count: stop until the next request; else sleep until the next thing to do
    if (s.left <= 0) stopTimer()
    else schedule($, nextDelay(s.left, cfg.pace, toasting ? cfg.toastAt : []))
  } finally {
    ticking = false
    if (rerun) {
      rerun = false
      void tick($).catch(stopTimer)
    }
  }
}

function schedule($: EngineInterface, delay: number) {
  timer?.cancel()
  // a tick that fails (engine refused a write, module unloading) stops the timer rather than retrying
  timer = $.clock.after(delay, () => void tick($).catch(stopTimer))
}

function startTimer($: EngineInterface) {
  stopTimer()
  void tick($).catch(stopTimer)
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
    const r = await $.config
      .set({ key: `${$.plugin.name}.${head.key}`, value: head.value })
      .catch((err: unknown) => ({ deny: String(err) }))
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

/** One status-line read: the model's context window, and the account when it decides the TTL. */
async function refreshUsage($: EngineInterface) {
  const usage = await $.session.usage().catch(() => undefined)
  if (usage && usage.context.window > 0) windowTokens = usage.context.window
  const first = decideTtl(cfg.ttlOption, env, setting)
  base = first.byAccount ? decideTtl(cfg.ttlOption, env, setting, accountOf(usage?.rateLimits ?? [])) : first
}

export const register: Register = (on, options) => {
  current = options
  const warnMsOpt = positive(options.warnSeconds, 60) * 1000
  cfg = {
    warnMs: warnMsOpt,
    pace: {
      tickMs: positive(options.tickSeconds, 60) * 1000,
      finalTickMs: positive(options.finalTickSeconds, 1) * 1000,
      warnMs: warnMsOpt,
    },
    toastAt: parseMarks(options.toastAt),
    contextAlerts: parsePercents(options.contextAlertsAt),
    compactWhenRemainingPct: pctOption(options.compactWhenRemainingPct, 60),
    showBand: options.band !== false,
    showStatus: options.status === true,
    wantToast: options.toast !== false,
    pinned: options.ttl === '5m' || options.ttl === '1h',
    ttlOption: options.ttl,
  }
  const { warnMs, showBand, showStatus, pinned } = cfg

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    toastedFor = 0
    toastLevel = Infinity
    lastStatus = undefined
    const none = () => undefined
    const [enable1h, force5m, ttlVar, disableAll, disableHaiku, disableSonnet, disableOpus] = await Promise.all([
      $.env.get('ENABLE_PROMPT_CACHING_1H').catch(none),
      $.env.get('FORCE_PROMPT_CACHING_5M').catch(none),
      $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(none),
      $.env.get('DISABLE_PROMPT_CACHING').catch(none),
      $.env.get('DISABLE_PROMPT_CACHING_HAIKU').catch(none),
      $.env.get('DISABLE_PROMPT_CACHING_SONNET').catch(none),
      $.env.get('DISABLE_PROMPT_CACHING_OPUS').catch(none),
    ])
    env = { enable1h, force5m, ttlVar, disableAll, disableHaiku, disableSonnet, disableOpus }
    // merged over user, project, local, --settings and managed policy, as the engine runs
    setting = (await $.settings.read().catch(() => ({}) as Record<string, unknown>)).promptCacheTtl
    await refreshUsage($)

    await $.command
      .register({
        name: COMMAND,
        description: 'Prompt-cache meter: countdown, last request, per-turn table (/cache setup configures, /cache stop closes)',
        argumentHint: '[setup|stop]',
        immediate: true,
      })
      .catch(err => $.ui.log(`cache-countdown: /${COMMAND} not registered: ${err}`, { to: 'debug' }))
    $.ui.log(`cache-countdown loaded: ${base.ttl} cache (${base.source}), /${COMMAND} opens the pane`, { to: 'debug' })

    // the wizard's remaining writes, if a write's reload cut the last load short
    await applyPending($).catch(err => $.ui.log(`cache-countdown: settings not written: ${err}`, { to: 'debug' }))
    // a newcomer hears about the wizard once, ever
    const seen = await $.store.get('setupSeen').catch(() => true)
    if (!seen) {
      $.ui.toast(`cache-countdown: /${COMMAND} setup picks the countdown step, toasts and more`)
      await $.store.set('setupSeen', true).catch(() => undefined)
    }

    // after a hot reload the samples are still in $.state: resume a live countdown
    stopTimer()
    const s = await snapshot($, await $.clock.now())
    if (s.left > 0) startTimer($)
    return r
  })

  on('session.end', async ($, e, next) => {
    stopTimer()
    if (e.reason === 'clear') {
      // /clear starts a new conversation: a new cache
      await update($, samplesAtom, () => [])
      await update($, observedAtom, () => null)
      await update($, alertedAtom, () => [])
      toastedFor = 0
      toastLevel = Infinity
      if (showStatus) {
        lastStatus = undefined
        $.ui.status(undefined)
      }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const startedAt = await $.clock.now()
    const r = yield* next(e)
    if (!r.usage) return r
    const sample: Sample = {
      turnId: e.turnId,
      index: e.index,
      model: r.usage.model || e.model,
      startedAt,
      read: r.usage.cache_read_input_tokens ?? 0,
      write: r.usage.cache_creation_input_tokens ?? 0,
      fresh: r.usage.input_tokens ?? 0,
      output: r.usage.output_tokens ?? 0,
    }
    let prev: Sample | undefined
    await update($, samplesAtom, list => {
      const all = list as Sample[]
      prev = all[all.length - 1]
      const grown = [...all, sample]
      return grown.length > KEEP ? grown.slice(-KEEP) : grown
    })
    // the window (model switches) and the account (a subscription running out of plan usage) can change mid-session
    await refreshUsage($)
    if (!pinned) {
      const known = ((await read($, observedAtom)) as Ttl | null) ?? undefined
      const seen = observeTtl(prev, sample, known)
      if (seen !== known) await update($, observedAtom, () => seen ?? null)
    }
    // context-window alerts: a toast as the conversation crosses each fill level, independent of the cache
    if (windowTokens > 0 && cfg.contextAlerts.length) {
      const used = promptTokens(sample)
      const left = remainingPct(used, windowTokens)
      const announced = (await read($, alertedAtom)) as number[]
      const alert = contextAlert(left, cfg.contextAlerts, announced)
      if (alert.announced.join() !== announced.join()) await update($, alertedAtom, () => alert.announced)
      if (alert.level !== undefined) {
        const tight = left <= cfg.compactWhenRemainingPct ? ' · /compact or /clear frees room' : ''
        $.ui.toast(`context: ${left}% of window remaining (${fmtTokens(used)} of ${fmtTokens(windowTokens)} used)${tight}`)
      }
    }
    $.ui.log(
      `cache-countdown: step read=${sample.read} write=${sample.write} new=${sample.fresh} model=${sample.model} ttl=${base.ttl} (${base.source}) window=${windowTokens}`,
      { to: 'debug' },
    )
    startTimer($)
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'setup') {
      await openSetup($)
      return { text: 'setup opened: pick, then Save (writes your Claude Code settings, as /config does)' }
    }
    if (arg === 'stop') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      await update($, paneAtom, () => false)
      return { text: 'cache pane closed' }
    }
    await update($, paneAtom, () => true)
    await $.ui.open({ id: PANE, title: 'cache', focus: true, closeOnEscape: true, columns: 64, rows: 24 })
    const s = await snapshot($, await $.clock.now())
    if (s.left > 0) startTimer($)
    return { text: `${s.ttl} cache (${s.source}) · ${s.advice.text} · /${COMMAND} stop closes` }
  })

  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) await update($, paneAtom, () => false)
    if (e.id === SETUP) await update($, draftAtom, () => null)
    return r
  })

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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand || e.props.hasSurvey) return next(e)
    if (await read($, paneAtom)) return next(e)
    await read($, tickAtom) // subscribes the band to the countdown
    const s = await snapshot($, await $.clock.now())
    const { last, advice, left, ttl } = s
    if (!last && advice.kind !== 'off') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const color = COLOR[advice.kind]

    if (!last) return <Text dimColor>{fit(`cache: ${advice.text}`, columns)}</Text>

    const ratio = hitRatio(last)
    const wide = columns >= 90
    const counting = advice.kind !== 'uncached' && advice.kind !== 'off'
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text bold color={color}>{ICON[advice.kind]}</Text>
        <Text bold color="cyan">cache</Text>
        <Text color={color}>{bar(ratio, wide ? 10 : 6)}</Text>
        <Text bold>{`${Math.round(ratio * 100)}%`}</Text>
        {/* siblings, not a fragment: the terminal lays a fragment out as a column */}
        {wide && <Text color="green">{`read ${fmtTokens(last.read)}`}</Text>}
        {wide && <Text color="yellow">{`wrote ${fmtTokens(last.write)}`}</Text>}
        {wide && <Text color="cyan">{`new ${fmtTokens(last.fresh)}`}</Text>}
        {!wide && <Text dimColor>{`${fmtTokens(promptTokens(last))} tok`}</Text>}
        {counting && <Text bold color={left > 0 ? lifeColor(left, ttl, warnMs) : 'red'}>{`⏱ ${fmtCountdown(left, cfg.pace)}`}</Text>}
        <Text dimColor wrap="truncate-end">{`${ttl} · ${advice.text}`}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tickAtom)
    const width = Math.max(30, e.props.bodyColumns - 1)
    // HTML collapses runs of spaces; a no-break space keeps columns aligned on desktop
    const sp = (t: string) => (e.surface === 'terminal' ? t : t.replace(/ /g, ' '))
    const s = await snapshot($, await $.clock.now())
    const { last, advice, left, ttl, source, samples } = s
    const turns = byTurn(samples)
    const sum = totals(samples)
    const counting = !!last && advice.kind !== 'uncached' && advice.kind !== 'off'
    const clockColor = counting ? lifeColor(left, ttl, warnMs) : undefined
    const stateColor = advice.kind === 'expired' || advice.kind === 'miss' ? 'red' : (clockColor ?? COLOR[advice.kind])

    // solid bars are filled Boxes, not block characters: no seams on desktop
    const solid = (key: string, parts: [number, string | undefined][]) => (
      <Box key={key} flexDirection="row" height={1} flexShrink={0}>
        {parts.map(([w, c], i) => (w > 0 ? <Box key={`${key}:${i}`} width={w} height={1} flexShrink={0} backgroundColor={c} /> : null))}
      </Box>
    )
    const cell = (key: string, w: number, text: string, c?: string, bold = false) => (
      <Box key={key} width={w} flexShrink={0} justifyContent="flex-end">
        <Text color={c} bold={bold} dimColor={!c}>{sp(text)}</Text>
      </Box>
    )
    const row = (key: string, label: string, r: { steps: number; read: number; write: number; fresh: number }, strong = false) => {
      const pct = Math.round(hitRatio(r) * 100)
      return (
        <Box key={key} flexDirection="row" columnGap={1}>
          {cell(`${key}:n`, 5, label, strong ? 'cyan' : undefined, strong)}
          {cell(`${key}:s`, 5, String(r.steps))}
          {cell(`${key}:r`, 6, fmtTokens(r.read), 'green')}
          {cell(`${key}:w`, 6, fmtTokens(r.write), 'yellow')}
          {cell(`${key}:f`, 5, fmtTokens(r.fresh), 'cyan')}
          {cell(`${key}:h`, 4, `${pct}%`, hitColor(pct), true)}
        </Box>
      )
    }

    const barW = Math.min(width, 40)
    const life = lifeRatio(left, ttl)
    const lifeFilled = Math.round(life * barW)
    const [sr, sw, sn] = last ? segments(last.read, last.write, last.fresh, barW) : [0, 0, 0]
    const shown = turns.slice(-Math.max(3, (e.viewport?.rows ?? 24) - 18))
    const lastPct = last ? Math.round(hitRatio(last) * 100) : 0

    return (
      <Box flexDirection="column">
        <Box key="title" flexDirection="row" columnGap={1}>
          <Text bold color="cyan">{sp('PROMPT CACHE')}</Text>
          <Text dimColor wrap="truncate-end">{sp(`· ${ttl} lifetime (${source})`)}</Text>
        </Box>

        <Box key="clock" flexDirection="column" marginTop={1}>
          <Text bold color={clockColor}>{sp(counting ? `⏱ ${fmtCountdown(left, cfg.pace)} left` : '⏱ --:--')}</Text>
          {counting ? (
            <Box flexDirection="row" columnGap={1}>
              {solid('life', [[lifeFilled, clockColor], [barW - lifeFilled, 'gray']])}
              <Text dimColor>{sp(`${Math.round(life * 100)}%`)}</Text>
            </Box>
          ) : null}
        </Box>

        <Box key="advice" marginTop={1} flexDirection="column">
          <Text bold color={stateColor}>{sp(`${ICON[advice.kind]} ${advice.text}`)}</Text>
          {last ? <Text dimColor>{sp(fit(`${last.model} · prompt ${fmtTokens(promptTokens(last))} tokens`, width))}</Text> : null}
        </Box>

        {last ? (
          <Box key="stack" flexDirection="column" marginTop={1}>
            <Text dimColor>{sp('last request')}</Text>
            <Box flexDirection="row" columnGap={1}>
              {solid('stack', [[sr, 'green'], [sw, 'yellow'], [sn, 'cyan']])}
              <Text bold color={hitColor(lastPct)}>{sp(`${lastPct}% hit`)}</Text>
            </Box>
            <Box flexDirection="row" columnGap={2}>
              <Text color="green">{sp(`■ read ${fmtTokens(last.read)}`)}</Text>
              <Text color="yellow">{sp(`■ wrote ${fmtTokens(last.write)}`)}</Text>
              <Text color="cyan">{sp(`■ new ${fmtTokens(last.fresh)}`)}</Text>
            </Box>
          </Box>
        ) : null}

        <Box key="table" flexDirection="column" marginTop={1}>
          <Box key="head" flexDirection="row" columnGap={1}>
            {cell('h:turn', 5, 'turn', 'cyan', true)}
            {cell('h:steps', 5, 'steps', 'cyan', true)}
            {cell('h:read', 6, 'read', 'green', true)}
            {cell('h:wrote', 6, 'wrote', 'yellow', true)}
            {cell('h:new', 5, 'new', 'cyan', true)}
            {cell('h:hit', 4, 'hit', 'magenta', true)}
          </Box>
          {shown.length === 0 ? <Text dimColor>{sp('no requests yet')}</Text> : null}
          {shown.map((t, i) => row(`t:${t.turnId}`, String(turns.length - shown.length + i + 1), t))}
          {turns.length > 0 ? row('total', 'all', sum, true) : null}
        </Box>

        <Box key="foot" marginTop={1} flexDirection="row" columnGap={2}>
          <Button key="close" label="close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
          <Text dimColor>{sp('read: from cache · wrote: new entry · new: uncached')}</Text>
        </Box>
      </Box>
    )
  })
}
