import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

import {
  accountKind,
  advise,
  baseLifetime,
  buildView,
  countdownText,
  effectiveLifetime,
  formatClock,
  formatCount,
  missCause,
  nextDelay,
  observe,
  parseMarks,
  parsePercents,
  parseSpan,
  remainingMs,
  spanWords,
  splitCells,
  takeMarks,
} from '../hooks/cache'
import type { Lifetime } from '../hooks/cache'
import { PRESETS, changes, draftFromOptions, splitToasts, toastsRow } from '../hooks/setup'
import type { CacheSample } from '../types'

const PLUGIN = 'cache-countdown'
const SURFACES = ['terminal', 'desktop'] as const
const T0 = 1_000_000
const MIN = 60_000
const STEPS = { warnSeconds: 60, tickSeconds: 60, finalTickSeconds: 1 }
const ADVICE = { warnSeconds: 60, compactWhenRemainingPct: 60 }

// ---------------------------------------------------------------- helpers

type WorldOptions = {
  env?: Record<string, string>
  window?: number
  limits?: { kind: string; percentUsed: number }[]
  settings?: Record<string, unknown>
  store?: Record<string, unknown>
}

type World = {
  clock: MockClock
  toasts: string[]
  logs: string[]
  statuses: (string | undefined)[]
  /** writes of the band/pane tick: one per wake that had someone to draw for */
  ticks: number
  usage: TurnUsage[]
}

/** Everything beneath the plugin: each `$` call it makes is answered here. */
function world(on: On, o: WorldOptions = {}): World {
  const w: World = { clock: mock.clock(on, { now: T0 }), toasts: [], logs: [], statuses: [], ticks: 0, usage: [] }
  mock.env(on, o.env ?? {})
  mock.store(on, o.store ?? { setupSeen: true })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined } as never
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.focus', () => ({ value: {} }) as never)
  on('command.register', () => ({ value: { command: 'cache' } }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: o.window ?? 0 }, rateLimits: o.limits ?? [] } }) as never)
  on('settings.read', () => ({ value: o.settings ?? {} }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('state.set', ($, e, pass) => {
    if (e.plugin === PLUGIN && e.key === 'tick') w.ticks++
    return pass(e)
  })
  on('turn.step', async function* ($, e) {
    const usage = w.usage.shift() ?? null
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  return w
}

async function start($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
}

type Request = { read: number; write: number; fresh: number; model?: string; turnId?: string; agentId?: string }

/** One model request through turn.step, read to its end. */
async function request($: Engine, w: World, r: Request) {
  const model = r.model ?? 'claude-opus-4-5'
  w.usage.push({ model, input_tokens: r.fresh, output_tokens: 50, cache_read_input_tokens: r.read, cache_creation_input_tokens: r.write })
  const stream = $.turn.step({ turnId: r.turnId ?? 't1', index: 0, model, messageCount: 3, ...(r.agentId ? { agentId: r.agentId } : {}) } as never)
  for await (const chunk of stream) void chunk
}

const TYPICAL = { read: 80_000, write: 1_000, fresh: 300 }

function band($: Engine, surface: (typeof SURFACES)[number] = 'terminal', bodyColumns = 120) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns, scroll: { offset: 0, bodyRows: 6 }, view: {} } as never,
  })
}

function pane($: Engine, surface: (typeof SURFACES)[number] = 'terminal') {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: 'cache',
    props: { title: 'cache', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never,
  })
}

const cacheToasts = (w: World) => w.toasts.filter(t => t.startsWith('cache expires'))
const contextToasts = (w: World) => w.toasts.filter(t => t.startsWith('context:'))

const sample = (at: number, read: number, write: number, fresh = 300, model = 'opus', turnId = 't1', turnNo = 1): CacheSample => ({
  at,
  turnId,
  turnNo,
  model,
  read,
  write,
  fresh,
  output: 10,
})

const FIVE: Lifetime = { ttl: 300, source: 'test', pinned: false }
const HOUR: Lifetime = { ttl: 3600, source: 'test', pinned: false }
const viewOf = (samples: CacheSample[], lifetime: Lifetime = FIVE, window = 0, off: string | null = null) => buildView({ samples, lifetime, off, window })

// ---------------------------------------------------------------- pure logic

describe('cache lifetime', () => {
  test('ttl order: option, FORCE_5M, env var, setting, ENABLE_1H, account', () => {
    expect(baseLifetime({ option: '1h', force5m: '1', account: 'other' })).toEqual({ ttl: 3600, source: 'ttl option', pinned: true })
    expect(baseLifetime({ option: 'auto', force5m: 'true', envTtl: '1h', settingTtl: '1h', account: 'subscription' })).toMatchObject({ ttl: 300, source: 'FORCE_PROMPT_CACHING_5M' })
    expect(baseLifetime({ option: 'auto', envTtl: '5m', enable1h: '1', account: 'subscription' })).toMatchObject({ ttl: 300, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' })
    expect(baseLifetime({ option: 'auto', settingTtl: '5m', enable1h: 'yes', account: 'subscription' })).toMatchObject({ ttl: 300, source: 'promptCacheTtl setting' })
    expect(baseLifetime({ option: 'auto', enable1h: 'ON', account: 'other' })).toMatchObject({ ttl: 3600, source: 'ENABLE_PROMPT_CACHING_1H' })
    expect(baseLifetime({ option: 'auto', settingTtl: '15m', envTtl: 'soon', force5m: '0', account: 'subscription' })).toMatchObject({ ttl: 3600, source: 'Claude subscription default' })
    expect(baseLifetime({ option: 'junk', account: 'credits' })).toMatchObject({ ttl: 300 })
    expect(baseLifetime({ option: 'auto', account: 'other' })).toMatchObject({ ttl: 300 })
  })

  test('account inference from the rate-limit windows', () => {
    expect(accountKind([{ kind: 'five_hour', percentUsed: 20 }])).toBe('subscription')
    expect(accountKind([{ kind: 'five_hour', percentUsed: 30 }, { kind: 'seven_day', percentUsed: 100 }])).toBe('credits')
    expect(accountKind([{ kind: 'spend_limit', percentUsed: 40 }])).toBe('other')
    expect(accountKind([])).toBe('other')
  })

  test('observation corrects the base unless pinned, and says so', () => {
    const base = baseLifetime({ option: 'auto', account: 'other' })
    expect(effectiveLifetime(base, { ttl: 3600, proven: true })).toMatchObject({ ttl: 3600, source: expect.stringContaining('observed from request timing') })
    expect(effectiveLifetime(base, { ttl: 300, proven: false }).source).toBe('API key or cloud provider, confirmed by traffic')
    expect(effectiveLifetime({ ttl: 300, source: 'ttl option', pinned: true }, { ttl: 3600, proven: true })).toMatchObject({ ttl: 300, source: 'ttl option' })
  })

  test('observed lifetime from request timing', () => {
    const prev = sample(0, 80_000, 1_000)
    expect(observe(null, prev, sample(20 * MIN, 81_000, 500))).toEqual({ ttl: 3600, proven: true })
    expect(observe(null, prev, sample(7 * MIN, 0, 81_300))).toEqual({ ttl: 300, proven: false })
    expect(observe(null, prev, sample(2 * MIN, 0, 81_300))).toBeNull()
    // a proven 1h is not undone by a later miss
    expect(observe({ ttl: 3600, proven: true }, prev, sample(7 * MIN, 0, 81_300))).toEqual({ ttl: 3600, proven: true })
    // a different model proves nothing
    expect(observe(null, prev, sample(20 * MIN, 81_000, 500, 300, 'sonnet'))).toBeNull()
  })
})

describe('advice', () => {
  const view = viewOf([sample(0, 80_000, 1_000)])
  test('warm, soon, expired on a 5m cache', () => {
    expect(advise(view, remainingMs(0, 300, 10_000), ADVICE)).toMatchObject({ state: 'warm', text: expect.stringMatching(/^warm/) })
    expect(advise(view, remainingMs(0, 300, 250_000), ADVICE)).toMatchObject({ state: 'soon', text: expect.stringMatching(/^expires soon.*any message refreshes it/) })
    expect(advise(view, remainingMs(0, 300, 300_000), ADVICE).state).toBe('expired')
  })

  test('a big expired prompt suggests /compact; window shown when known', () => {
    const big = viewOf([sample(0, 180_000, 5_000)])
    expect(advise(big, 0, ADVICE).text).toContain('/compact')
    expect(advise(big, 0, ADVICE).text).not.toContain('% of window')
    expect(advise(viewOf([sample(0, 80_000, 1_000)], FIVE, 1_000_000), 0, ADVICE).text).toContain('92% of window remaining), keep going')
    expect(advise(viewOf([sample(0, 80_000, 1_000)], FIVE, 120_000), 0, ADVICE).text).toContain('32% of window remaining). /compact first')
  })

  test('off, uncached, cold', () => {
    expect(advise(viewOf([sample(0, 80_000, 1_000)], FIVE, 0, 'DISABLE_PROMPT_CACHING'), 100_000, ADVICE)).toMatchObject({ state: 'off', text: expect.stringContaining('prompt caching is off') })
    expect(advise(viewOf([sample(0, 0, 0, 500)]), 100_000, ADVICE)).toMatchObject({ state: 'uncached', text: expect.stringContaining('not cached') })
    expect(advise(viewOf([]), 0, ADVICE).state).toBe('cold')
  })

  test('remaining counts from the start of the last request', () => {
    expect(remainingMs(0, 3600, 100_000)).toBe(3_500_000)
    expect(remainingMs(0, 300, 400_000)).toBe(0)
  })

  test('miss causes', () => {
    const prev = sample(0, 80_000, 1_000, 300, 'opus')
    expect(missCause(prev, sample(MIN, 0, 81_000, 300, 'sonnet'), 300)).toBe('model changed (opus → sonnet)')
    expect(missCause(prev, sample(7 * MIN, 0, 81_000), 300)).toBe('the 5m cache had lapsed')
    expect(missCause(prev, sample(MIN, 2_000, 79_000), 300)).toContain('prompt prefix changed')
    expect(missCause(prev, sample(MIN, 0, 9_000), 300)).toBeNull()
    expect(missCause(prev, sample(MIN, 81_000, 400), 300)).toBeNull()
    expect(advise(viewOf([prev, sample(MIN, 0, 81_000, 300, 'sonnet')]), 200_000, ADVICE).text).toBe('miss: model changed (opus → sonnet)')
  })
})

describe('toast marks', () => {
  test('ticking each second fires each mark once, in order', () => {
    const marks = [60, 10, 3, 1]
    let shown = 0
    const fired: number[] = []
    for (let s = 70; s >= 1; s--) {
      const r = takeMarks(marks, shown, s * 1000)
      shown = r.shown
      if (r.fire !== undefined) fired.push(r.fire)
    }
    expect(fired).toEqual([60, 10, 3, 1])
  })

  test('a late tick fires only the newest mark passed', () => {
    expect(takeMarks([60, 10, 3, 1], 0, 2_000)).toEqual({ fire: 3, shown: 3 })
  })

  test('parsing marks and spans', () => {
    expect(parseMarks('junk')).toEqual([60, 10, 5, 1])
    expect(parseMarks('5,300,5')).toEqual([300, 5])
    expect(parseMarks('30m, 15m, 5m, 1m')).toEqual([1800, 900, 300, 60])
    expect(parseMarks('5m,2m,1m')).toEqual([300, 120, 60])
    expect(parseMarks('1m, 10s, 5s, 1s')).toEqual([60, 10, 5, 1])
    expect(parseSpan('1h')).toBe(3600)
    expect(parseSpan('1.5 min')).toBe(90)
    expect(parseSpan('90')).toBe(90)
    expect(parseSpan('5x')).toBeUndefined()
    expect(parsePercents('75, 50, 25, 10, 5')).toEqual([75, 50, 25, 10, 5])
    expect(parsePercents('off')).toEqual([])
    expect(parsePercents('')).toEqual([])
    expect(parsePercents('junk')).toEqual([50, 25, 10])
  })

  test('span words', () => {
    expect(spanWords(1800)).toBe('30 min')
    expect(spanWords(3600)).toBe('1 hr')
    expect(spanWords(90)).toBe('1:30')
    expect(spanWords(10)).toBe('10s')
  })
})

describe('countdown and timer', () => {
  test('countdown text with 60s / 1s steps', () => {
    expect(countdownText(3_582_000, STEPS)).toBe('60m')
    expect(countdownText(3_540_000, STEPS)).toBe('59m')
    expect(countdownText(61_000, STEPS)).toBe('2m')
    expect(countdownText(60_000, STEPS)).toBe('1:00')
    expect(countdownText(42_300, STEPS)).toBe('0:43')
    expect(countdownText(0, STEPS)).toBe('0:00')
    expect(countdownText(3_582_000, { ...STEPS, tickSeconds: 1 })).toBe('59:42')
  })

  test('next delay: the next change of the text, the final stretch, or a mark', () => {
    expect(nextDelay(3_582_000, STEPS)).toBe(42_000)
    expect(nextDelay(90_000, STEPS)).toBe(30_000)
    expect(nextDelay(42_000, STEPS)).toBe(1_000)
    expect(nextDelay(400_000, STEPS, [300], 0)).toBe(40_000)
    expect(nextDelay(330_000, STEPS, [315], 0)).toBe(15_000)
    expect(nextDelay(0, STEPS)).toBeNull()
  })
})

describe('formatting', () => {
  test('counts and clocks', () => {
    expect(formatCount(84_200)).toBe('84.2k')
    expect(formatCount(300)).toBe('300')
    expect(formatCount(100_000)).toBe('100k')
    expect(formatClock(200_000)).toBe('3:20')
    expect(formatClock(3_600_000)).toBe('1:00:00')
  })

  test('the stacked bar fills its cells and shows every part', () => {
    const parts = splitCells([80_000, 1_000, 300], 40)
    expect(parts.reduce((a, b) => a + b, 0)).toBe(40)
    for (const n of parts) expect(n).toBeGreaterThanOrEqual(1)
    expect(splitCells([0, 0, 0], 10)).toEqual([0, 0, 0])
  })

  test('per-turn rows and totals add up', () => {
    const v = viewOf([
      sample(0, 0, 50_000, 300, 'opus', 'a', 1),
      sample(10_000, 50_000, 2_000, 200, 'opus', 'a', 1),
      sample(MIN, 52_000, 1_000, 100, 'opus', 'b', 2),
    ])
    expect(v.rows.map(r => [r.label, r.steps])).toEqual([['1', 2], ['2', 1]])
    expect(v.total).toMatchObject({ label: 'all', steps: 3 })
    expect(v.rows.reduce((a, r) => a + r.read, 0)).toBe(v.total.read)
    expect(v.rows.reduce((a, r) => a + r.write, 0)).toBe(v.total.write)
    expect(v.rows.reduce((a, r) => a + r.fresh, 0)).toBe(v.total.fresh)
    expect(viewOf([sample(0, 1, 1)], HOUR).ttlLabel).toBe('1h')
  })
})

// ---------------------------------------------------------------- the module

describe('band', () => {
  for (const surface of SURFACES) {
    test(`${surface}: empty before the first request, then the meter`, async ($, on) => {
      const w = world(on)
      await start($)
      const b = await band($, surface)
      expect(await b.find({ type: 'Text', text: /cache/ })).toBeUndefined()
      await request($, w, TYPICAL)
      expect(await b.find({ type: 'Text', text: '98%' })).toBeDefined()
      expect(await b.find({ type: 'Text', text: 'read 80k' })).toBeDefined()
      expect(await b.find({ type: 'Text', text: 'wrote 1k' })).toBeDefined()
      expect(await b.find({ type: 'Text', text: 'new 300' })).toBeDefined()
      expect(await b.find({ type: 'Text', text: '⏱ 5m' })).toBeDefined()
      expect(await b.find({ type: 'Text', text: '5m · warm' })).toBeDefined()
      await b.unmount()
    })
  }

  test('narrow band shows the prompt size instead of the three counts', async ($, on) => {
    const w = world(on)
    await start($)
    const b = await band($, 'terminal', 70)
    await request($, w, TYPICAL)
    expect(await b.find({ type: 'Text', text: 'prompt 81.3k' })).toBeDefined()
    expect(await b.find({ type: 'Text', text: 'read 80k' })).toBeUndefined()
    await b.unmount()
  })

  test('a subagent request records nothing; a main request logs once', async ($, on) => {
    const w = world(on)
    await start($)
    await request($, w, { ...TYPICAL, agentId: 'agent-1' })
    expect(w.logs.filter(l => l.includes('step read='))).toHaveLength(0)
    await request($, w, TYPICAL)
    expect(w.logs.filter(l => l.includes('step read='))).toHaveLength(1)
    expect(w.logs.find(l => l.includes('step read='))).toContain('read=80000')
  })

  test('/clear empties the band', async ($, on) => {
    const w = world(on)
    await start($)
    const b = await band($)
    await request($, w, TYPICAL)
    expect(await b.find({ type: 'Text', text: 'read 80k' })).toBeDefined()
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(await b.find({ type: 'Text', text: /read|cache/ })).toBeUndefined()
    await b.unmount()
  })

  test('caching off: says so, no countdown, no wakes', async ($, on) => {
    const w = world(on, { env: { DISABLE_PROMPT_CACHING: '1' } })
    await start($)
    const b = await band($)
    expect(await b.find({ type: 'Text', text: /prompt caching is off/ })).toBeDefined()
    await request($, w, TYPICAL)
    expect(await b.find({ type: 'Text', text: /prompt caching is off/ })).toBeDefined()
    expect(await b.find({ type: 'Text', text: /⏱/ })).toBeUndefined()
    await w.clock.advance(10 * MIN)
    expect(w.ticks).toBe(0)
    await b.unmount()
  })
})

describe('countdown', () => {
  test('5m with marks 60,10,3,1: soon, four toasts, expired, then no wakes', { options: { toastAt: '60,10,3,1' } }, async ($, on) => {
    const w = world(on)
    await start($)
    const b = await band($)
    await request($, w, TYPICAL)
    expect(await b.find({ type: 'Text', text: '⏱ 5m' })).toBeDefined()
    await w.clock.advance(250_000)
    expect(await b.find({ type: 'Text', text: '⏱ 0:50' })).toBeDefined()
    expect(await b.find({ type: 'Text', text: /expires soon/ })).toBeDefined()
    await w.clock.advance(50_000)
    const toasts = cacheToasts(w)
    expect(toasts).toHaveLength(4)
    expect(toasts[0]).toContain('expires in 1 min')
    expect(toasts[0]).toContain('keep 81.3k warm')
    expect(toasts[3]).toContain('1s')
    expect(toasts[3]).toContain('send a message now')
    expect(await b.find({ type: 'Text', text: /expired/ })).toBeDefined()
    const wakes = w.ticks
    await w.clock.advance(30 * MIN)
    expect(w.ticks).toBe(wakes)
    expect(cacheToasts(w)).toHaveLength(4)
    await b.unmount()
  })

  test('1h on defaults: about two wakes a minute-step hour', { options: {}, timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on, { limits: [{ kind: 'five_hour', percentUsed: 20 }] })
    await start($)
    await request($, w, TYPICAL)
    await w.clock.advance(61 * MIN)
    expect(w.ticks).toBeGreaterThanOrEqual(100)
    expect(w.ticks).toBeLessThanOrEqual(130)
  })

  test('1h with tickSeconds 10', { options: { tickSeconds: 10 }, timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on, { limits: [{ kind: 'five_hour', percentUsed: 20 }] })
    await start($)
    await request($, w, TYPICAL)
    await w.clock.advance(61 * MIN)
    expect(w.ticks).toBeGreaterThanOrEqual(400)
    expect(w.ticks).toBeLessThanOrEqual(430)
  })

  test('toastAt 30,5: two toasts, 30s then 5s', { options: { toastAt: '30,5' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await request($, w, TYPICAL)
    await w.clock.advance(6 * MIN)
    const toasts = cacheToasts(w)
    expect(toasts).toHaveLength(2)
    expect(toasts[0]).toContain('30s')
    expect(toasts[1]).toContain('5s')
  })

  test('1h with marks 30m,15m,5m,1m', { options: { ttl: '1h', toastAt: '30m,15m,5m,1m' }, timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await start($)
    await request($, w, TYPICAL)
    await w.clock.advance(61 * MIN)
    const toasts = cacheToasts(w)
    expect(toasts).toHaveLength(4)
    expect(toasts[0]).toStartWith('cache expires in 30 min')
    expect(toasts[1]).toContain('15 min')
    expect(toasts[2]).toContain('5 min')
    expect(toasts[3]).toContain('1 min')
  })

  test('a new request re-arms the marks', { options: { toastAt: '10s' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await request($, w, TYPICAL)
    await w.clock.advance(295_000)
    expect(cacheToasts(w)).toHaveLength(1)
    await request($, w, TYPICAL)
    await w.clock.advance(295_000)
    expect(cacheToasts(w)).toHaveLength(2)
  })
})

describe('context window alerts', () => {
  test('one toast for the lowest level crossed, not repeated', async ($, on) => {
    const w = world(on, { window: 100_000 })
    await start($)
    await request($, w, TYPICAL)
    expect(contextToasts(w)).toEqual(['context: 19% of window remaining (81.3k of 100k used) · /compact or /clear frees room'])
    await request($, w, { read: 81_000, write: 400, fresh: 200 })
    expect(contextToasts(w)).toHaveLength(1)
  })

  test('a 1M window crosses nothing; the cache toast still fires once', { options: { toastAt: '10s' } }, async ($, on) => {
    const w = world(on, { window: 1_000_000 })
    await start($)
    await request($, w, TYPICAL)
    await w.clock.advance(6 * MIN)
    expect(contextToasts(w)).toHaveLength(0)
    expect(cacheToasts(w)).toHaveLength(1)
  })

  test('contextAlertsAt off: none', { options: { contextAlertsAt: 'off' } }, async ($, on) => {
    const w = world(on, { window: 100_000 })
    await start($)
    await request($, w, TYPICAL)
    expect(contextToasts(w)).toHaveLength(0)
  })

  for (const [window, fragment] of [
    [1_000_000, '92% of window remaining), keep going'],
    [120_000, '32% of window remaining). /compact first'],
  ] as const) {
    test(`expired advice on a ${window} window`, async ($, on) => {
      const w = world(on, { window })
      await start($)
      const b = await band($)
      await request($, w, TYPICAL)
      await w.clock.advance(5 * MIN)
      expect(await b.find({ type: 'Text', text: fragment })).toBeDefined()
      await b.unmount()
    })
  }
})

describe('lifetime sources at load', () => {
  const cases = [
    ['subscription', {}, { limits: [{ kind: 'five_hour', percentUsed: 20 }] }, '1h cache (Claude subscription default)'],
    ['env var', {}, { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, limits: [{ kind: 'five_hour', percentUsed: 20 }] }, '5m cache (CLAUDE_CODE_PROMPT_CACHE_TTL)'],
    ['setting', {}, { settings: { promptCacheTtl: '1h' } }, '1h cache (promptCacheTtl setting)'],
    ['option', { ttl: '5m' }, { limits: [{ kind: 'five_hour', percentUsed: 20 }] }, '5m cache (ttl option)'],
  ] as const
  for (const [name, options, worldOptions, line] of cases) {
    test(name, { options }, async ($, on) => {
      const w = world(on, worldOptions as WorldOptions)
      await start($)
      expect(w.logs.find(l => l.startsWith('cache-countdown loaded:'))).toContain(line)
    })
  }
})

describe('/cache', () => {
  for (const surface of SURFACES) {
    test(`${surface}: the pane, and the band steps aside while it is open`, async ($, on) => {
      const w = world(on)
      await start($)
      const b = await band($, surface)
      await request($, w, TYPICAL)
      const r = await $.command.run({ command: 'cache', args: '' } as never)
      expect((r as { text: string }).text).toContain('5m cache')
      expect((r as { text: string }).text).toContain('/cache stop closes')
      const p = await pane($, surface)
      expect(await p.find({ type: 'Text', text: 'PROMPT CACHE' })).toBeDefined()
      expect(await p.find({ type: 'Text', text: '⏱ 5m left' })).toBeDefined()
      expect(await p.find({ type: 'Text', text: '98% hit' })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /^all$/ })).toBeDefined()
      expect(await p.find({ type: 'Button', key: 'close' })).toBeDefined()
      expect(await b.find({ type: 'Text', text: 'read 80k' })).toBeUndefined()
      await p.press({ key: 'close' })
      await p.unmount()
      expect(await b.find({ type: 'Text', text: 'read 80k' })).toBeDefined()
      await b.unmount()
    })
  }

  test('/cache stop closes the pane', async ($, on) => {
    const w = world(on)
    await start($)
    const b = await band($)
    await request($, w, TYPICAL)
    await $.command.run({ command: 'cache', args: '' } as never)
    expect(await b.find({ type: 'Text', text: 'read 80k' })).toBeUndefined()
    const r = await $.command.run({ command: 'cache', args: 'stop' } as never)
    expect((r as { text: string }).text).toContain('cache pane closed')
    expect(await b.find({ type: 'Text', text: 'read 80k' })).toBeDefined()
    await b.unmount()
  })

  test('the footer line, when on', { options: { status: true } }, async ($, on) => {
    const w = world(on, { limits: [{ kind: 'five_hour', percentUsed: 20 }] })
    await start($)
    await request($, w, TYPICAL)
    expect(w.statuses.at(-1)).toBe('cache 98% · 60m')
    await w.clock.advance(61 * MIN)
    expect(w.statuses.at(-1)).toBe('cache 98% · expired')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(w.statuses.at(-1)).toBeUndefined()
  })

  test('first load ever: one toast pointing at /cache setup', async ($, on) => {
    const w = world(on, { store: {} })
    await start($)
    await start($)
    expect(w.toasts.filter(t => t.includes('/cache setup'))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- the walkthrough (adapted from the kept tests)

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
