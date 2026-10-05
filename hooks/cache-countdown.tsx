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
 *          band, status, toast, toastAt, toastWhenRemainingPct.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import {
  accountOf,
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
import { changes, choicesFor, decode, draftFromOptions, encode, FIELDS, PRESETS } from './setup'
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
  /** toasts fire only once the window remaining is at or below this percentage (100 = always) */
  toastWhenRemainingPct: number
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
  toastWhenRemainingPct: 100,
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
    const toasting = cfg.wantToast && !!s.last && s.left > 0 && promptTokens(s.last) >= usedAt(windowTokens || DEFAULT_WINDOW, cfg.toastWhenRemainingPct)
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
  await $.ui.open({ id: SETUP, title: 'cache setup', focus: true, closeOnEscape: true, columns: 76, rows: 22 })
  await $.store.set('setupSeen', true).catch(() => undefined)
}

async function saveSetup($: EngineInterface) {
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
    toastWhenRemainingPct: pctOption(options.toastWhenRemainingPct, 100),
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
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const preset = PRESETS.find(p => FIELDS.every(f => encode(p.draft[f.key] ?? '') === encode(draft[f.key] ?? '')))
    const count = changes(draft, current).length

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text bold color="cyan">cache-countdown setup</Text>
          <Text dimColor>{`· detected ${s.ttl} (${s.source})`}</Text>
        </Box>
        <Box key="actions" flexDirection="row" columnGap={2}>
          <Button key="save" label={count ? `Save ${count} change${count === 1 ? '' : 's'}` : 'Save'} variant="primary" onPress={() => void saveSetup($)} />
          <Button key="reset" label="Recommended" onPress={() => void presetSetup($, PRESETS[0]!.draft)} />
          <Button key="cancel" label="Cancel" role="dismiss" onPress={() => void $.ui.close({ id: SETUP })} />
        </Box>
        <Box key="preset">
          <Select
            key="preset"
            label="Preset"
            options={[...PRESETS.map(p => ({ value: p.key, label: p.label })), ...(preset ? [] : [{ value: 'custom', label: 'Custom' }])]}
            value={preset?.key ?? 'custom'}
            onSelect={v => {
              const p = PRESETS.find(x => x.key === v)
              if (p) void presetSetup($, p.draft)
            }}
          />
        </Box>
        <Text key="about" dimColor wrap="wrap">{preset ? preset.about : 'your own picks'}</Text>
        <Box key="fields" flexDirection="column">
          {FIELDS.map(f => (
            <Select
              key={f.key}
              label={f.label}
              options={choicesFor(f, draft[f.key]).map(c => ({ value: encode(c.value), label: c.label }))}
              value={encode(draft[f.key] ?? '')}
              onSelect={v => void pickSetup($, f.key, decode(f, v))}
            />
          ))}
        </Box>
        <Text dimColor wrap="wrap">Save writes your Claude Code settings, like /config · Tab moves · Esc closes without saving</Text>
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
