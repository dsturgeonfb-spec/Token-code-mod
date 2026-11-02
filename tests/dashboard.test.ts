import { expect, mock, test } from 'claude-code/testing'

import { addTranscript, newTally, reportOf } from '../hooks/parse'
import { groupBy, partsOf, totalOf } from '../hooks/pricing'
import type { UsageRow } from '../types'

/** Dollars to whole cents, so float noise does not fail a check. */
const cents = (usd: number) => Math.round(usd * 100)

const today = new Date().toISOString().slice(0, 10)

const row = (over: Partial<UsageRow>): UsageRow => ({
  p: 'C:\\code\\alpha', m: 'claude-opus-5-5', d: today, s: 'sess-a', f: false,
  i: 0, o: 0, w5: 0, w1: 0, r: 0, n: 1, ot: 0, ox: 0, oc: 0, ...over,
})

test('prices each token type at list rates', async () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read; writes 1.25x / 2x input
  const parts = partsOf(row({
    i: 1_000_000, w5: 1_000_000, w1: 1_000_000, r: 1_000_000,
    o: 1_000_000, ot: 500_000, ox: 300_000, oc: 200_000,
  }))
  expect(cents(parts.input.usd)).toBe(400)
  expect(cents(parts.write.usd)).toBe(1300)
  expect(cents(parts.read.usd)).toBe(20)
  expect(cents(parts.thinking.usd)).toBe(1000)
  expect(cents(parts.text.usd)).toBe(600)
  expect(cents(parts.tools.usd)).toBe(400)
  expect(cents(totalOf([row({ o: 1_000_000, ox: 1_000_000, f: true })]).usd)).toBe(4000)
  expect(cents(totalOf([row({ m: 'claude-sonnet-5-5', o: 1_000_000, ox: 1_000_000 })]).usd)).toBe(1000)
  expect(totalOf([row({ m: 'mystery-model', o: 1_000_000 })]).usd).toBe(0)
})

test('output with no split counts as reply text', async () => {
  const parts = partsOf(row({ o: 1000 }))
  expect(parts.text.tokens).toBe(1000)
  expect(parts.thinking.tokens).toBe(0)
})

test('groups by project, most expensive first', async () => {
  const groups = groupBy(
    [row({ p: 'a', o: 1000 }), row({ p: 'b', o: 5000 }), row({ p: 'a', o: 1000 })],
    r => r.p,
  )
  expect(groups.map(g => g.name)).toEqual(['b', 'a'])
  expect(groups[1]?.calls).toBe(2)
})

test('pane shows this session, projects and the token split in GBP', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  mock.store(on)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\someone' })
  const report = {
    scannedAt: new Date().toISOString(),
    files: 2,
    rows: [
      row({ p: 'C:\\code\\alpha', s: 'sess-a', o: 1_000_000, ot: 500_000, ox: 500_000 }),
      row({ p: 'C:\\code\\beta', s: 'sess-b', m: 'claude-sonnet-5-5', o: 500_000, oc: 500_000 }),
    ],
    sessions: [
      { id: 'sess-a', title: 'Build the alpha thing', project: 'C:\\code\\alpha', start: '' },
      { id: 'sess-b', title: 'Fix beta', project: 'C:\\code\\beta', start: '' },
    ],
  }
  on('process.run', () => ({
    value: {
      exitCode: 0, stdout: JSON.stringify(report), stderr: '',
      isStdoutTruncated: false, isStderrTruncated: false,
    },
  }))
  on('http.fetch', () => ({
    value: {
      status: 200, ok: true, headers: {},
      text: JSON.stringify({ date: today, rates: { GBP: 0.5 } }),
    },
  }))
  on('session.id', () => ({ value: 'sess-a' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({
    command: 'token-spend',
    args: '',
    origin: { kind: 'plugin', name: 'token-spend' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'token-spend', surface, component: 'Pane', requestId: 'token-spend',
      props: {
        title: 'Token spend (GBP)',
        isFocused: false,
        bodyColumns: 90,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    await ui.press({ key: 'refresh' })
    // alpha: 1M Opus 5.5 output = $20 = £10; beta: 0.5M Sonnet output = $5 = £2.50
    expect(await ui.find({ type: 'Text', text: /This session\s+£10\.00/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Today\s+£12\.50/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /alpha.*£10\.00/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● Build the alpha thing.*£10\.00/ })).toBeDefined()
    // thinking 500k of 1.5M tokens = 33%, £5 of £12.50 = 40%
    expect(await ui.find({ type: 'Text', text: /Thinking\s+500\.0k\s+33%\s+£5\.00\s+40%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Tool calls \(est\.\)\s+500\.0k\s+33%\s+£2\.50\s+20%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('reads transcripts in place when there is no PowerShell', async () => {
  const usage = {
    input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50 },
    output_tokens_details: { thinking_tokens: 40 },
  }
  const lines = [
    { type: 'user', timestamp: `${today}T09:00:00Z`, message: { role: 'user', content: 'Plan the RFQ app' } },
    { type: 'assistant', cwd: '/home/user/rfq', timestamp: `${today}T09:00:05Z`, requestId: 'req_1',
      message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '' }], usage } },
    { type: 'assistant', cwd: '/home/user/rfq', timestamp: `${today}T09:00:05Z`, requestId: 'req_1',
      message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Here is the plan' }], usage } },
  ]
  const tally = newTally()
  addTranscript(tally, lines.map(l => JSON.stringify(l)).join('\n'), 'sess-cloud', 'proj', false)
  const result = reportOf(tally, new Date().toISOString())
  expect(result.rows.length).toBe(1)
  const only = result.rows[0]
  expect(only?.n).toBe(1)
  expect(only?.w1).toBe(50)
  expect(only?.ot).toBe(40)
  expect(only?.ox).toBe(60)
  expect(result.sessions[0]?.title).toBe('Plan the RFQ app')
  expect(result.sessions[0]?.project).toBe('/home/user/rfq')
})
