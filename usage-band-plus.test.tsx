import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

const HOUR_MS = 3600 * 1000
const NOW = Date.parse('2026-10-10T12:00:00Z')
const SURFACES = ['terminal', 'desktop'] as const

const FOOTER = { component: 'SessionMode', props: { modes: [] as readonly string[] } } as const
const HIGH_CONTEXT = { context: { tokens: 170000, window: 200000, percent: 85 } }

const bandAt = (bodyColumns: number) =>
  ({
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    },
  }) as const

const usageWith = (overrides: Partial<SessionUsage> = {}): SessionUsage => ({
  startedAt: NOW - HOUR_MS,
  context: { tokens: 50000, window: 200000, percent: 25 },
  cost: { usd: 1.5 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 90, resetsAt: new Date(NOW + 4 * HOUR_MS).toISOString() },
    { kind: 'seven_day', percentUsed: 32, resetsAt: new Date(NOW + 76 * HOUR_MS).toISOString() },
  ],
  ...overrides,
})

type StepOptions = { model?: string; agentId?: string; hitPct: number }

// Every hook beneath the plugin is registered before the test first calls $.
function stubSession(
  on: On,
  opts: { model?: string; usage?: () => SessionUsage; isForkFailing?: boolean } = {},
) {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const commands: string[] = []
  const fills: string[] = []
  let compactCount = 0
  let step: StepOptions = { hitPct: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.model', () => ({ value: opts.model ?? 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'not-a-uuid' }))
  on('session.usage', () => ({ value: (opts.usage ?? usageWith)() }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.compact', () => {
    compactCount += 1
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: step.model ?? 'claude-opus-5-5',
        input_tokens: 100 - step.hitPct,
        cache_read_input_tokens: step.hitPct,
        cache_creation_input_tokens: 0,
        output_tokens: 10,
      },
    }
  })
  const noUsage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.fork', () => ({
    value: opts.isForkFailing
      ? { isAnswered: false as const, reason: 'api-error' as const, status: 400, error: 'invalid_request' as const, usage: noUsage }
      : { isAnswered: true as const, text: 'NOTE', usage: noUsage },
  }))
  on('model.complete', () => ({ value: { isAnswered: true as const, text: 'HAIKU NOTE', usage: noUsage } }))
  on('session.messages', () => ({
    value: [{ role: 'user' as const, text: 'please fix the bug in foo.ts', toolUses: [] }],
  }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('prompt.read', () => ({ value: { text: 'my draft', cursor: 8 } }))
  on('command.run', ($, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })

  async function runStep($: Engine, options: StepOptions) {
    step = options
    const stream = $.turn.step({
      turnId: 't1',
      index: 0,
      model: options.model ?? 'claude-opus-5-5',
      messageCount: 3,
      ...(options.agentId ? { agentId: options.agentId } : {}),
    })
    for await (const _chunk of stream) {
    }
  }

  return { clock, toasts, commands, fills, runStep, compacts: () => compactCount }
}

const startSession = ($: Engine) =>
  $.session.start({ cwd: '/tmp/project', surface: 'terminal', isInteractive: true })

const explain = async ($: Engine) =>
  (
    await $.command.run({
      command: 'usage-band',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
  ).text ?? ''

test('nothing draws before any usage is read', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  for (const surface of SURFACES) {
    const footer = await $.ui.mount({ plugin: 'usage-band-plus', surface, ...FOOTER })
    expect(await footer.find({ type: 'Text', text: /context/ })).toBeUndefined()
    await footer.unmount()
    const band = await $.ui.mount({ plugin: 'usage-band-plus', surface, ...bandAt(140) })
    expect(await band.find({ type: 'Button', key: 'handoff' })).toBeUndefined()
    await band.unmount()
  }
})

test('footer shows three numbers with middle dots and keeps the engine modes', async ($, on) => {
  const { runStep } = stubSession(on)
  await startSession($)
  await runStep($, { hitPct: 90 })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface, component: 'SessionMode', props: { modes: ['focus'] } })
    const row = await ui.find({ type: 'Text' })
    expect(row?.text).toBe('25%\u2002·\u2002~$1.50\u2002·\u2002≈60m\u2002·\u2002focus')
    await ui.unmount()
  }
})

test('/usage-band explains each number with its current value', async ($, on) => {
  const { runStep } = stubSession(on)
  await startSession($)
  await runStep($, { hitPct: 90 })
  await runStep($, { hitPct: 5, agentId: 'sub-1' })

  const text = await explain($)
  expect(text).toMatch(/^Footer: 25% · ~\$1\.50 · ≈60m/)
  expect(text).toMatch(/Context: 50k of 200k tokens \(25%\)/)
  expect(text).toMatch(/estimate, not a charge/)
  expect(text).toMatch(/Prompt cache: warm until /)
  expect(text).toMatch(/read 90% of its input from cache/)
  expect(text).not.toMatch(/read 5%/)
})
test('a [1m] session model on the same model is not cold', async ($, on) => {
  const { runStep } = stubSession(on, { model: 'claude-opus-5-5[1m]' })
  await startSession($)
  await runStep($, { hitPct: 90, model: 'claude-opus-5-5' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface, ...FOOTER })
    expect(await ui.find({ type: 'Text', text: /^cold$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a real model switch shows the cache as cold', async ($, on) => {
  const { runStep } = stubSession(on, { model: 'claude-sonnet-5-5' })
  await startSession($)
  await runStep($, { hitPct: 90, model: 'claude-opus-5-5' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface, ...FOOTER })
    expect(await ui.find({ type: 'Text', text: /^cold$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/usage-band names the last turn cost', async ($, on) => {
  let usd = 1.5
  stubSession(on, { usage: () => usageWith({ cost: { usd } }) })
  await startSession($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  usd = 1.62
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(await explain($)).toMatch(/Last turn: \+\$0\.12/)
})

test('five minutes before expiry: one alert and a Compact or Let it expire row', async ($, on) => {
  const { clock, toasts, runStep, compacts } = stubSession(on)
  const notifications = () => toasts.filter(text => /Prompt cache expires/.test(text))
  await startSession($)
  await runStep($, { hitPct: 90 })

  await clock.advance(HOUR_MS - 6 * 60 * 1000)
  expect(notifications()).toHaveLength(0)
  const early = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...bandAt(160) })
  expect(await early.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  await early.unmount()

  await clock.advance(70 * 1000)
  expect(notifications()).toHaveLength(1)
  expect(notifications()[0]).toMatch(/Compact from the prompt, or let it expire/)
  await clock.advance(30 * 1000)
  expect(notifications()).toHaveLength(1)

  for (const surface of SURFACES) {
    const prompt = await $.ui.mount({ plugin: 'usage-band-plus', surface, ...bandAt(160) })
    expect(await prompt.find({ type: 'Text', text: /Prompt cache expires in 4:/ })).toBeDefined()
    expect(await prompt.find({ type: 'Button', key: 'compact' })).toBeDefined()
    await prompt.unmount()
  }

  const band = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...bandAt(160) })
  await band.press({ key: 'compact' })
  expect(compacts()).toBe(1)
  expect(await band.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  await band.unmount()
})

test('Let it expire hides the row for that cache', async ($, on) => {
  const { clock, runStep } = stubSession(on)
  await startSession($)
  await runStep($, { hitPct: 90 })
  await clock.advance(HOUR_MS - 4 * 60 * 1000)

  const band = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...bandAt(160) })
  await band.press({ key: 'let-expire' })
  expect(await band.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  await band.unmount()
})

test('the band stays hidden below the handoff threshold', async ($, on) => {
  stubSession(on)
  await startSession($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface, ...bandAt(160) })
    expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeUndefined()
    await ui.unmount()
  }
})

test('at high context the band offers Handoff and toasts once', async ($, on) => {
  const { toasts } = stubSession(on, { usage: () => usageWith(HIGH_CONTEXT) })
  await startSession($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface, ...bandAt(160) })
    expect((await ui.find({ type: 'Button', key: 'handoff' }))?.props.variant).toBe('primary')
    expect(await ui.find({ type: 'Text', text: /Context is 85% full/ })).toBeDefined()
    await ui.unmount()
  }
  expect(toasts.filter(t => /Handoff is ready/.test(t))).toHaveLength(1)
})

test('Handoff asks for confirmation, then clears, keeps the draft and resets the cache', async ($, on) => {
  let usd = 1.5
  const { commands, fills, runStep } = stubSession(on, {
    usage: () => usageWith({ ...HIGH_CONTEXT, cost: { usd } }),
  })
  await startSession($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await runStep($, { hitPct: 90 })
  usd = 1.62
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...bandAt(160) })
  await ui.press({ key: 'handoff' })
  expect(commands).toHaveLength(0)
  expect((await ui.find({ type: 'Button', key: 'handoff' }))?.props.label).toBe('Confirm handoff')

  await ui.press({ key: 'handoff' })
  expect(commands).toEqual(['clear'])
  expect(fills).toHaveLength(1)
  expect(fills[0]).toMatch(/NOTE/)
  expect(fills[0]).toMatch(/my draft$/)
  await ui.unmount()

  const footer = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...FOOTER })
  expect(await footer.find({ type: 'Text', text: /60m/ })).toBeUndefined()
  await footer.unmount()
})

test('Handoff falls back to Haiku when the fork fails', async ($, on) => {
  const { fills } = stubSession(on, { isForkFailing: true, usage: () => usageWith(HIGH_CONTEXT) })
  await startSession($)

  const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...bandAt(160) })
  await ui.press({ key: 'handoff' })
  await ui.press({ key: 'handoff' })
  expect(fills).toHaveLength(1)
  expect(fills[0]).toMatch(/HAIKU NOTE/)
  await ui.unmount()
})

test('/handoff runs without the band', async ($, on) => {
  const { clock, commands, fills } = stubSession(on)
  await startSession($)
  await $.command.run({
    command: 'handoff',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  await clock.settle()
  expect(commands).toContain('clear')
  expect(fills[0]).toMatch(/NOTE/)
})

test('a typed /clear resets the cache item', async ($, on) => {
  const { runStep } = stubSession(on)
  await startSession($)
  await runStep($, { hitPct: 90 })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...FOOTER })
  expect(await ui.find({ type: 'Text', text: /60m/ })).toBeUndefined()
  await ui.unmount()
})

test('band placement draws the readout above the prompt instead', { options: { placement: 'band' } }, async ($, on) => {
  stubSession(on)
  await startSession($)

  const band = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...bandAt(160) })
  expect(await band.find({ type: 'Text', text: /^25%$/ })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'handoff' })).toBeDefined()
  await band.unmount()

  const footer = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'terminal', ...FOOTER })
  expect(await footer.find({ type: 'Text', text: /^25%$/ })).toBeUndefined()
  await footer.unmount()
})

test('context is measured against the auto-compact window when the engine reports one', async ($, on) => {
  stubSession(on, {
    usage: () =>
      ({
        ...usageWith({ context: { tokens: 340000, window: 1000000, percent: 34 } }),
        context: { tokens: 340000, window: 1000000, percent: 34, breakdown: { rawMaxTokens: 500000 } },
      }) as unknown as SessionUsage,
  })
  await startSession($)

  const ui = await $.ui.mount({ plugin: 'usage-band-plus', surface: 'desktop', ...FOOTER })
  expect(await ui.find({ type: 'Text', text: /^68%$/ })).toBeDefined()
  await ui.unmount()
  const text = await explain($)
  expect(text).toMatch(/340k of 500k tokens/)
  expect(text).toMatch(/the model allows 1M/)
})
