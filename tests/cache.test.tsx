// Run with: claude plugin test <this mod's folder>
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  accountOf,
  advise,
  decideTtl,
  fmtClock,
  fmtCountdown,
  nextDelay,
  parseMarks,
  parseSpan,
  fmtSpan,
  fmtCount,
  missReason,
  nextToastMark,
  observeTtl,
  remainingMs,
  segments,
  totals,
} from '../hooks/cache'
import type { Pace, Policy, Sample } from '../hooks/cache'
import { changes, draftFromOptions, PRESETS, splitToasts, toastsRow } from '../hooks/setup'

const T0 = 1_000_000_000_000
const MIN = 60_000
const policy: Policy = { ttl: '5m', warnMs: 60_000, compactAtTokens: 100_000 }
const sample = (over: Partial<Sample> = {}): Sample => ({
  turnId: 't1',
  index: 0,
  model: 'claude-sonnet-5-5',
  startedAt: T0,
  read: 80_000,
  write: 1_000,
  fresh: 500,
  output: 300,
  ...over,
})

describe('pure logic', () => {
  test('TTL follows the documented order', () => {
    expect(decideTtl('1h', { force5m: '1' }, '5m', 'other').ttl).toBe('1h')
    expect(decideTtl('auto', { force5m: '1', ttlVar: '1h' }, '1h', 'subscription').source).toBe('FORCE_PROMPT_CACHING_5M')
    expect(decideTtl('auto', { ttlVar: '5m', enable1h: '1' }, '1h', 'subscription').source).toBe('CLAUDE_CODE_PROMPT_CACHE_TTL')
    expect(decideTtl('auto', { enable1h: '1' }, '5m', 'other').source).toBe('promptCacheTtl setting')
    expect(decideTtl('auto', { enable1h: '1' }, undefined, 'other').ttl).toBe('1h')
    expect(decideTtl('auto', {}, 'junk', 'subscription')).toEqual({ ttl: '1h', source: 'Claude subscription default', byAccount: true })
    expect(decideTtl('auto', {}, undefined, 'credits').ttl).toBe('5m')
    expect(accountOf([{ kind: 'five_hour', percentUsed: 20 }])).toBe('subscription')
    expect(accountOf([{ kind: 'five_hour', percentUsed: 100 }])).toBe('credits')
    expect(accountOf([{ kind: 'spend_limit', percentUsed: 10 }])).toBe('other')
  })

  test('advice: warm, soon, expired; big context suggests /compact', () => {
    const s = sample()
    expect(advise(s, undefined, policy, T0 + 10_000, false).kind).toBe('warm')
    expect(advise(s, undefined, policy, T0 + 250_000, false).kind).toBe('soon')
    expect(advise(s, undefined, policy, T0 + 300_000, false).kind).toBe('expired')
    expect(advise(sample({ read: 150_000 }), undefined, policy, T0 + 400_000, false).text).toContain('/compact')
    expect(advise(sample(), undefined, policy, T0, true).kind).toBe('off')
    expect(advise(sample({ read: 0, write: 0 }), undefined, policy, T0, false).kind).toBe('uncached')
    expect(remainingMs(s, '1h', T0 + 100_000)).toBe(3_500_000)
  })

  test('misses name their cause; /compact is not a miss', () => {
    const prev = sample({ read: 50_000, write: 1_000, fresh: 200 })
    const wrote = { read: 0, write: 52_000, fresh: 300 }
    expect(missReason(prev, sample({ ...wrote, model: 'claude-opus-5-5', startedAt: T0 + 20_000 }), '5m')).toContain('model changed')
    expect(missReason(prev, sample({ ...wrote, startedAt: T0 + 400_000 }), '5m')).toContain('had lapsed')
    expect(missReason(prev, sample({ ...wrote, startedAt: T0 + 20_000 }), '5m')).toContain('prefix changed')
    expect(missReason(prev, sample({ read: 0, write: 8_000, fresh: 100 }), '5m')).toBeUndefined()
  })

  test('toast marks fire once each, in order; a late tick skips to the newest', () => {
    const marks = parseMarks('60, 10, 3, 1')
    expect(marks).toEqual([60, 10, 3, 1])
    let level = Infinity
    const fired: number[] = []
    for (let secs = 70; secs >= 1; secs--) {
      const m = nextToastMark(secs, marks, level)
      if (m !== undefined) {
        fired.push(secs)
        level = m
      }
    }
    expect(fired).toEqual([60, 10, 3, 1])
    expect(nextToastMark(2, marks, Infinity)).toBe(3)
    expect(parseMarks('junk')).toEqual([60, 10, 5, 1])
    expect(parseMarks('5,300,5')).toEqual([300, 5])
    expect(parseMarks('30m, 15m, 5m, 1m')).toEqual([1800, 900, 300, 60])
    expect(parseMarks('5m,2m,1m')).toEqual([300, 120, 60])
    expect(parseMarks('1m, 10s, 5s, 1s')).toEqual([60, 10, 5, 1])
    expect(parseSpan('1h')).toBe(3600)
    expect(parseSpan('1.5 min')).toBe(90)
    expect(parseSpan('90')).toBe(90)
    expect(parseSpan('5x')).toBeUndefined()
    expect(fmtSpan(1800)).toBe('30 min')
    expect(fmtSpan(3600)).toBe('1 hr')
    expect(fmtSpan(90)).toBe('1:30')
    expect(fmtSpan(10)).toBe('10s')
  })

  test('pace: minute steps, then seconds in the final stretch; the timer sleeps until the next change', () => {
    const pace: Pace = { tickMs: 60_000, finalTickMs: 1_000, warnMs: 60_000 }
    expect(fmtCountdown(3_582_000, pace)).toBe('60m')
    expect(fmtCountdown(3_540_000, pace)).toBe('59m')
    expect(fmtCountdown(61_000, pace)).toBe('2m')
    expect(fmtCountdown(60_000, pace)).toBe('1:00')
    expect(fmtCountdown(42_300, pace)).toBe('0:43')
    expect(fmtCountdown(0, pace)).toBe('0:00')
    // 59:42 left: next change at 59:00, 42 s away
    expect(nextDelay(3_582_000, pace, [])).toBe(42_000)
    // 1:30 left: the final stretch starts in 30 s
    expect(nextDelay(90_000, pace, [])).toBe(30_000)
    // inside it, every second
    expect(nextDelay(42_000, pace, [])).toBe(1_000)
    // a toast mark outside the stretch wakes it too
    expect(nextDelay(400_000, pace, [300])).toBe(40_000)
    const fine: Pace = { tickMs: 1_000, finalTickMs: 1_000, warnMs: 60_000 }
    expect(fmtCountdown(3_582_000, fine)).toBe('59:42')
  })

  test('observed TTL: a late hit proves 1h; a late miss says 5m', () => {
    const prev = sample()
    expect(observeTtl(prev, sample({ startedAt: T0 + 20 * MIN }), undefined)).toBe('1h')
    expect(observeTtl(prev, sample({ startedAt: T0 + 7 * MIN, read: 0, write: 81_000 }), undefined)).toBe('5m')
    expect(observeTtl(prev, sample({ startedAt: T0 + 2 * MIN, read: 0, write: 81_000 }), undefined)).toBeUndefined()
  })

  test('formatting, segments, totals', () => {
    expect(fmtClock(200_000)).toBe('3:20')
    expect(fmtClock(3_600_000)).toBe('1:00:00')
    expect(fmtCount(84_200)).toBe('84.2k')
    const seg = segments(113_000, 4_000, 2, 40)
    expect(seg[0] + seg[1] + seg[2]).toBe(40)
    expect(seg[2]).toBeGreaterThanOrEqual(1)
    expect(totals([sample(), sample({ turnId: 't2' })]).read).toBe(160_000)
  })
})

// ---- the module end to end, against the engine's own $ with a mocked clock ----

type World = { toasts: string[]; status: (string | undefined)[]; logs: string[]; ticks: number; clock: MockClock }

function world(
  on: On,
  opts: { env?: Record<string, string>; cache?: { read: number; write: number }; limits?: { kind: string; percentUsed: number }[]; settings?: Record<string, unknown>; window?: number } = {},
): World {
  const w = { toasts: [] as string[], status: [] as (string | undefined)[], logs: [] as string[], ticks: 0 } as World
  const cache = opts.cache ?? { read: 80_000, write: 1_000 }
  // every tick writes the band's `tick` value: counting the writes counts the timer's work
  on('state.set', { plugin: 'cache-countdown', key: 'tick' }, ($, e, next) => {
    w.ticks += 1
    return next(e)
  })
  w.clock = mock.clock(on, { now: T0 })
  mock.env(on, opts.env ?? {})
  mock.store(on, { setupSeen: true })
  on('session.usage', () => ({ value: { startedAt: 0, context: opts.window ? { window: opts.window } : {}, rateLimits: opts.limits ?? [] } }) as never)
  on('settings.read', () => ({ value: opts.settings ?? {} }) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.end', async () => ({ sessionId: 's1' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    w.toasts.push(String((e as { text: unknown }).text))
    return { value: undefined } as never
  })
  on('ui.log', ($, e) => {
    w.logs.push(String((e as { text: unknown }).text))
    return { value: undefined } as never
  })
  on('ui.status', ($, e) => {
    w.status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  // the engine's own drawing when the mod passes (band hidden): nothing
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-sonnet-5-5', input_tokens: 300, output_tokens: 50, cache_read_input_tokens: cache.read, cache_creation_input_tokens: cache.write },
    } as never
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true } as never)

async function step($: Engine, over: { turnId?: string; index?: number; agentId?: string } = {}) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 3, ...over } as never)
  for (;;) {
    const n = await stream.next()
    if (n.done) return n.value
  }
}

const band = ($: Engine) =>
  $.ui.mount({ plugin: 'cache-countdown', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 120 } as never })

describe('band', () => {
  test('nothing before the first request; then hit %, read/wrote/new and the countdown', async ($, on) => {
    world(on)
    await start($)
    const empty = await band($)
    expect(await empty.find({ type: 'Text', text: /cache/ })).toBeUndefined()
    await empty.unmount()

    await step($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /^98%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /read 80k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /wrote 1k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /new 300/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⏱ 5m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5m · warm/ })).toBeDefined()
    await ui.unmount()
  })

  test('a subagent request leaves the meter alone', async ($, on) => {
    const w = world(on)
    await start($)
    await step($, { agentId: 'agent-1' })
    expect(w.logs.some(l => l.includes('step read='))).toBe(false)
    await step($)
    expect(w.logs.filter(l => l.includes('step read=')).length).toBe(1)
  })

  test('countdown runs, toasts at 60/10/3/1s, then the timer STOPS once expired', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.advance(250_000)
    const mid = await band($)
    expect(await mid.find({ type: 'Text', text: /⏱ 0:50/ })).toBeDefined()
    expect(await mid.find({ type: 'Text', text: /expires soon/ })).toBeDefined()
    await mid.unmount()
    await w.clock.advance(51_000)
    expect(w.toasts.length).toBe(4)
    expect(w.toasts[0]).toContain('expires in 1 min')
    expect(w.toasts[3]).toContain('1s')
    const done = await band($)
    expect(await done.find({ type: 'Text', text: /expired/ })).toBeDefined()
    await done.unmount()
    // idle and expired: no timer, so ten more minutes cost zero ticks
    const before = w.ticks
    await w.clock.advance(600_000)
    expect(w.ticks).toBe(before)
  })


  test('DISABLE_PROMPT_CACHING says off and runs no countdown', async ($, on) => {
    const w = world(on, { env: { DISABLE_PROMPT_CACHING: '1' } })
    await start($)
    await step($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /prompt caching is off/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⏱/ })).toBeUndefined()
    await ui.unmount()
    const before = w.ticks
    await w.clock.advance(60_000)
    expect(w.ticks).toBe(before)
  })
})

describe('surfaces', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`band and pane draw on ${surface}`, async ($, on) => {
      world(on)
      await start($)
      await step($)
      const b = await $.ui.mount({ plugin: 'cache-countdown', surface, component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 120 } as never })
      expect(await b.find({ type: 'Text', text: /read 80k/ })).toBeDefined()
      await b.unmount()
      await $.command.run({ command: 'cache', args: '' } as never)
      const p = await $.ui.mount({ plugin: 'cache-countdown', surface, component: 'Pane', requestId: 'cache', props: { title: 'cache', isFocused: true, bodyColumns: 60, placement: 'dock' } as never } as never)
      expect(await p.find({ type: 'Text', text: /PROMPT CACHE|PROMPT CACHE/ })).toBeDefined()
      await p.unmount()
    })
  }
})

describe('pace and toasts are configurable', () => {
  test('1h cache on defaults: ~120 wakes in an hour (once a minute, then per second in the last minute)', { options: { ttl: '1h' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.advance(3_600_000)
    expect(w.ticks).toBeGreaterThan(100)
    expect(w.ticks).toBeLessThan(130)
  })

  test('tickSeconds 10 ticks six times as often outside the final stretch', { options: { ttl: '1h', tickSeconds: 10 } }, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.advance(3_600_000)
    expect(w.ticks).toBeGreaterThan(400)
    expect(w.ticks).toBeLessThan(430)
  })

  test('toastAt picks the marks', { options: { toastAt: '30,5' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.advance(301_000)
    expect(w.toasts.length).toBe(2)
    expect(w.toasts[0]).toContain('30s')
    expect(w.toasts[1]).toContain('5s')
  })

  test('context alerts: one toast as the window crosses levels, not repeated', async ($, on) => {
    // 81.3k of a 100k window: 19% remaining, past 50% and 25% at once, so one toast for 25%
    const w = world(on, { window: 100_000 })
    await start($)
    await step($)
    await step($, { index: 1 })
    const alerts = w.toasts.filter(t => t.startsWith('context:'))
    expect(alerts).toEqual(['context: 19% of window remaining (81.3k of 100k used) · /compact or /clear frees room'])
  })

  test('context alerts stay quiet with plenty of room, and are independent of cache toasts', { options: { toastAt: '10s' } }, async ($, on) => {
    const w = world(on, { window: 1_000_000 })
    await start($)
    await step($)
    await w.clock.advance(301_000)
    expect(w.toasts.filter(t => t.startsWith('context:'))).toEqual([])
    expect(w.toasts.filter(t => t.startsWith('cache expires')).length).toBe(1)
  })

  test('contextAlertsAt off disables them', { options: { contextAlertsAt: 'off' } }, async ($, on) => {
    const w = world(on, { window: 100_000 })
    await start($)
    await step($)
    expect(w.toasts.filter(t => t.startsWith('context:'))).toEqual([])
  })

  test('/compact advice follows window remaining, and says how much is left', async ($, on) => {
    const w = world(on, { window: 1_000_000 })
    await start($)
    await step($)
    await w.clock.advance(301_000)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /92% of window remaining\), keep going/ })).toBeDefined()
    await ui.unmount()
  })

  test('on a 120k window the same context (32% remaining) suggests /compact', async ($, on) => {
    const w = world(on, { window: 120_000 })
    await start($)
    await step($)
    await w.clock.advance(301_000)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /32% of window remaining\)\. \/compact first/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('toasts in minutes', () => {
  test('30m,15m,5m,1m on a 1h cache: four toasts worded in minutes', { options: { ttl: '1h', toastAt: '30m,15m,5m,1m' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.advance(3_601_000)
    expect(w.toasts).toEqual([
      'cache expires in 30 min: send a message to keep 81.3k tokens warm',
      'cache expires in 15 min: send a message to keep 81.3k tokens warm',
      'cache expires in 5 min: send a message to keep 81.3k tokens warm',
      'cache expires in 1 min: send a message to keep 81.3k tokens warm',
    ])
  })
})

describe('setup walkthrough', () => {
  test('pure: draft from options, toast row, changes', () => {
    const d = draftFromOptions({ ttl: 'auto', tickSeconds: 60, warnSeconds: 60, finalTickSeconds: 1, toast: true, toastAt: '1m,10s,5s,1s', contextAlertsAt: '50,25,10', compactWhenRemainingPct: 60, band: true, status: false })
    expect(d).toEqual(PRESETS[0]!.draft)
    expect(toastsRow(false, '60')).toBe('off')
    expect(splitToasts('off')).toEqual({ toast: false })
    const quiet = PRESETS.find(p => p.key === 'quiet')!.draft
    expect(changes(quiet, { ...d, toast: true, toastAt: '1m,10s,5s,1s' })).toEqual([
      { key: 'finalTickSeconds', value: 10 },
      { key: 'toast', value: false },
      { key: 'contextAlertsAt', value: 'off' },
    ])
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(surface + ': preset step, skip to review, Save writes only what changed', async ($, on) => {
      const w = world(on)
      const written: { key: string; value: unknown }[] = []
      on('config.set', ($, e) => {
        written.push({ key: e.key, value: e.value })
        return { value: e.value } as never
      })
      await start($)
      const r = await $.command.run({ command: 'cache', args: 'setup' } as never)
      expect((r as { text: string }).text).toContain('setup opened')
      const pane = await $.ui.mount({ plugin: 'cache-countdown', surface, component: 'Pane', requestId: 'cache-setup', props: { title: 'cache setup', isFocused: true, bodyColumns: 80, placement: 'dock' } as never })
      expect(await pane.find({ type: 'Text', text: /step 1 of 11/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /Start from a preset/ })).toBeDefined()
      await pane.press({ key: 'pick:preset:live' })
      await pane.press({ key: 'review' })
      expect(await pane.find({ type: 'Text', text: /Review and save/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'save', text: /Save 4 changes/ })).toBeDefined()
      await pane.press({ key: 'save' })
      await pane.unmount()
      expect(written).toEqual([
        { key: 'cache-countdown.tickSeconds', value: 1 },
        { key: 'cache-countdown.toastAt', value: '5m,2m,1m' },
        { key: 'cache-countdown.contextAlertsAt', value: '75,50,25,10,5' },
        { key: 'cache-countdown.status', value: true },
      ])
      expect(w.toasts.at(-1)).toContain('tickSeconds = 1')
    })
  }

  test('each step explains its setting; Next and Back walk the steps', async ($, on) => {
    world(on)
    await start($)
    await $.command.run({ command: 'cache', args: 'setup' } as never)
    const pane = await $.ui.mount({ plugin: 'cache-countdown', surface: 'terminal', component: 'Pane', requestId: 'cache-setup', props: { title: 'cache setup', isFocused: true, bodyColumns: 80, placement: 'dock' } as never })
    await pane.press({ key: 'next' })
    expect(await pane.find({ type: 'Text', text: /step 2 of 11/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Cache lifetime$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Claude caches the start of your conversation/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'pick:ttl:auto' })).toBeDefined()
    await pane.press({ key: 'back' })
    expect(await pane.find({ type: 'Text', text: /step 1 of 11/ })).toBeDefined()
    await pane.unmount()
  })

  test('custom… opens a text field; what you type is cleaned and saved', async ($, on) => {
    world(on)
    const written: { key: string; value: unknown }[] = []
    on('config.set', ($, e) => {
      written.push({ key: e.key, value: e.value })
      return { value: e.value } as never
    })
    await start($)
    await $.command.run({ command: 'cache', args: 'setup' } as never)
    const pane = await $.ui.mount({ plugin: 'cache-countdown', surface: 'terminal', component: 'Pane', requestId: 'cache-setup', props: { title: 'cache setup', isFocused: true, bodyColumns: 80, placement: 'dock' } as never })
    await pane.press({ key: 'review' })
    await pane.press({ key: 'edit:toasts' })
    expect(await pane.find({ type: 'Text', text: /^Cache expiry toasts$/ })).toBeDefined()
    await pane.press({ key: 'pick:toasts:__custom' })
    await pane.input({ key: 'in:toasts', text: '45m, 20m, junk, 2m' })
    await pane.press({ key: 'review' })
    expect(await pane.find({ type: 'Button', key: 'edit:toasts', text: /custom: 45m,20m,2m/ })).toBeDefined()
    await pane.press({ key: 'edit:contextAlertsAt' })
    await pane.press({ key: 'pick:contextAlertsAt:__custom' })
    await pane.input({ key: 'in:contextAlertsAt', text: '75, 50, 25, 10, 5' })
    await pane.press({ key: 'review' })
    await pane.press({ key: 'save' })
    await pane.unmount()
    expect(written).toEqual([
      { key: 'cache-countdown.toastAt', value: '45m,20m,2m' },
      { key: 'cache-countdown.contextAlertsAt', value: '75,50,25,10,5' },
    ])
  })

  test('text typed but not submitted is kept when you move on', async ($, on) => {
    world(on)
    await start($)
    await $.command.run({ command: 'cache', args: 'setup' } as never)
    const pane = await $.ui.mount({ plugin: 'cache-countdown', surface: 'terminal', component: 'Pane', requestId: 'cache-setup', props: { title: 'cache setup', isFocused: true, bodyColumns: 80, placement: 'dock' } as never })
    await pane.press({ key: 'review' })
    await pane.press({ key: 'edit:toasts' })
    await pane.press({ key: 'pick:toasts:__custom' })
    await pane.input({ key: 'in:toasts', text: '45m, 20m, 2m', kind: 'change' })
    await pane.press({ key: 'review' })
    expect(await pane.find({ type: 'Button', key: 'edit:toasts', text: /custom: 45m,20m,2m/ })).toBeDefined()
    await pane.unmount()
  })

  test('a denied write is reported, not swallowed', async ($, on) => {
    const w = world(on)
    on('config.set', () => ({ deny: 'locked by managed settings' }) as never)
    await start($)
    await $.command.run({ command: 'cache', args: 'setup' } as never)
    const pane = await $.ui.mount({ plugin: 'cache-countdown', surface: 'terminal', component: 'Pane', requestId: 'cache-setup', props: { title: 'cache setup', isFocused: true, bodyColumns: 80, placement: 'dock' } as never })
    await pane.press({ key: 'review' })
    await pane.press({ key: 'edit:status' })
    await pane.press({ key: 'pick:status:true' })
    await pane.press({ key: 'review' })
    await pane.press({ key: 'save' })
    await pane.unmount()
    expect(w.toasts.at(-1)).toContain('status not saved (locked by managed settings)')
  })
})

describe('ttl sources', () => {
  test('a Claude subscription defaults to 1h', async ($, on) => {
    const w = world(on, { limits: [{ kind: 'five_hour', percentUsed: 12 }] })
    await start($)
    expect(w.logs.join('\n')).toContain('1h cache (Claude subscription default)')
  })
  test('CLAUDE_CODE_PROMPT_CACHE_TTL beats the subscription default', async ($, on) => {
    const w = world(on, { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, limits: [{ kind: 'five_hour', percentUsed: 12 }] })
    await start($)
    expect(w.logs.join('\n')).toContain('5m cache (CLAUDE_CODE_PROMPT_CACHE_TTL)')
  })
  test('the promptCacheTtl setting (merged, managed included) is read', async ($, on) => {
    const w = world(on, { settings: { promptCacheTtl: '1h' } })
    await start($)
    expect(w.logs.join('\n')).toContain('1h cache (promptCacheTtl setting)')
  })
  test('the ttl option pins it', { options: { ttl: '5m' } }, async ($, on) => {
    const w = world(on, { env: { ENABLE_PROMPT_CACHING_1H: '1' } })
    await start($)
    expect(w.logs.join('\n')).toContain('5m cache (ttl option)')
  })
})

describe('/cache pane', () => {
  test('opens with countdown, last-request bar and per-turn table; the band steps aside', async ($, on) => {
    world(on)
    await start($)
    await step($, { turnId: 'a' })
    await step($, { turnId: 'a', index: 1 })
    await step($, { turnId: 'b' })
    const r = await $.command.run({ command: 'cache', args: '' } as never)
    expect((r as { text: string }).text).toContain('5m cache')
    const pane = await $.ui.mount({ plugin: 'cache-countdown', surface: 'terminal', component: 'Pane', requestId: 'cache', props: { title: 'cache', isFocused: true, bodyColumns: 60, placement: 'dock' } as never } as never)
    expect(await pane.find({ type: 'Text', text: /PROMPT CACHE/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /⏱ 5m left/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /98% hit/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^all$/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'close' })).toBeDefined()
    await pane.unmount()
    const b = await band($)
    expect(await b.find({ type: 'Text', text: /cache/ })).toBeUndefined()
    await b.unmount()
    await $.command.run({ command: 'cache', args: 'stop' } as never)
    const back = await band($)
    expect(await back.find({ type: 'Text', text: /read 80k/ })).toBeDefined()
    await back.unmount()
  })

  test('/clear starts the meter over', async ($, on) => {
    world(on)
    await start($)
    await step($)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /cache/ })).toBeUndefined()
    await ui.unmount()
  })
})
