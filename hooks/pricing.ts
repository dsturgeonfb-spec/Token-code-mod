import type { Range, UsageRow } from '../types'

// USD per million tokens: [input, output, cache read], first prefix match wins.
// Cache writes are priced off input: 1.25x for the 5-minute TTL, 2x for 1 hour.
// Anthropic API list prices as of October 2026.
const PRICES: [string, number, number, number][] = [
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1],
  ['claude-mythos-5', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-opus-4-5', 5, 25, 0.5],
  ['claude-opus-4', 15, 75, 1.5],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-3-7-sonnet', 3, 15, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4-5', 1, 5, 0.1],
  ['claude-3-5-haiku', 0.8, 4, 0.08],
]

export const priceOf = (model: string) => {
  const bare = model.replace(/^(us\.|eu\.|global\.)?anthropic\./, '').replace(/@.*$/, '')
  const hit = PRICES.find(([prefix]) => bare.startsWith(prefix))

  return hit === undefined ? undefined : { input: hit[1], output: hit[2], read: hit[3] }
}

export const isPriced = (model: string) => priceOf(model) !== undefined

/** Where tokens go: what the model read (input side) and what it wrote (output side). */
export const PARTS = [
  { key: 'read', side: 'Input', label: 'Cache reads (re-read context)' },
  { key: 'write', side: 'Input', label: 'Cache writes (new context)' },
  { key: 'input', side: 'Input', label: 'Fresh input (uncached)' },
  { key: 'thinking', side: 'Output', label: 'Thinking' },
  { key: 'text', side: 'Output', label: 'Reply text (est.)' },
  { key: 'tools', side: 'Output', label: 'Tool calls (est.)' },
] as const

export type PartKey = (typeof PARTS)[number]['key']

export type Amount = { tokens: number; usd: number }

export type Parts = Record<PartKey, Amount>

const noParts = (): Parts => ({
  read: { tokens: 0, usd: 0 },
  write: { tokens: 0, usd: 0 },
  input: { tokens: 0, usd: 0 },
  thinking: { tokens: 0, usd: 0 },
  text: { tokens: 0, usd: 0 },
  tools: { tokens: 0, usd: 0 },
})

/** Tokens and USD cost of one row, per part; fast mode bills at twice the standard rate. */
export const partsOf = (row: UsageRow): Parts => {
  const price = priceOf(row.m) ?? { input: 0, output: 0, read: 0 }
  const scale = (row.f ? 2 : 1) / 1_000_000
  const out = price.output * scale
  // Older transcripts carry no split: their output counts as reply text.
  const split = (row.ot ?? 0) + (row.ox ?? 0) + (row.oc ?? 0) === row.o
  const thinking = split ? row.ot : 0
  const tools = split ? row.oc : 0
  const text = row.o - thinking - tools

  return {
    read: { tokens: row.r, usd: row.r * price.read * scale },
    write: { tokens: row.w5 + row.w1, usd: (row.w5 * 1.25 + row.w1 * 2) * price.input * scale },
    input: { tokens: row.i, usd: row.i * price.input * scale },
    thinking: { tokens: thinking, usd: thinking * out },
    text: { tokens: text, usd: text * out },
    tools: { tokens: tools, usd: tools * out },
  }
}

export type Group = { name: string; tokens: number; usd: number; calls: number; parts: Parts }

/** Totals rows by a key, most expensive first. */
export const groupBy = (rows: UsageRow[], keyOf: (row: UsageRow) => string): Group[] => {
  const groups = new Map<string, Group>()
  for (const row of rows) {
    const name = keyOf(row)
    const group = groups.get(name) ?? { name, tokens: 0, usd: 0, calls: 0, parts: noParts() }
    const parts = partsOf(row)
    for (const { key } of PARTS) {
      group.parts[key].tokens += parts[key].tokens
      group.parts[key].usd += parts[key].usd
      group.tokens += parts[key].tokens
      group.usd += parts[key].usd
    }
    group.calls += row.n
    groups.set(name, group)
  }

  return [...groups.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens)
}

/** One total over all rows (an empty group when there are none). */
export const totalOf = (rows: UsageRow[]): Group =>
  groupBy(rows, () => 'all')[0] ?? { name: 'all', tokens: 0, usd: 0, calls: 0, parts: noParts() }

/** First UTC day (YYYY-MM-DD) a range covers, or '' for all time. */
export const firstDayOf = (range: Range, nowMs: number) => {
  const back = { today: 0, '7d': 6, '30d': 29, all: -1 }[range]
  if (back < 0) return ''

  return new Date(nowMs - back * 86_400_000).toISOString().slice(0, 10)
}
