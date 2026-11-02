// Reads transcripts without PowerShell, for machines that have none (a cloud
// session runs on Linux). Same totals as scripts/scan.ps1.
import type { Report, SessionInfo, UsageRow } from '../types'

type Call = {
  p: string; m: string; d: string; s: string; f: boolean
  i: number; o: number; w5: number; w1: number; r: number
  think: number; textChars: number; toolChars: number
}

export type Tally = { calls: Map<string, Call>; sessions: Map<string, SessionInfo>; files: number; skipped: string[] }

export const newTally = (): Tally => ({ calls: new Map(), sessions: new Map(), files: 0, skipped: [] })

type Line = {
  type?: string
  cwd?: string
  timestamp?: string
  requestId?: string
  message?: {
    id?: string
    model?: string
    role?: string
    content?: unknown
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
      output_tokens_details?: { thinking_tokens?: number }
      speed?: string
    }
  }
}

/** Adds one transcript's calls; `session` is the transcript's session id. */
export const addTranscript = (tally: Tally, text: string, session: string, fallback: string, isSubagent: boolean) => {
  tally.files += 1
  const meta = tally.sessions.get(session) ?? { id: session, title: '', project: '', start: '' }
  tally.sessions.set(session, meta)
  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }
    const message = line.message
    if (line.type === 'user' && !isSubagent && meta.title === '' && typeof message?.content === 'string'
      && !message.content.startsWith('<')) {
      meta.title = message.content.slice(0, 120)
      if (meta.start === '') meta.start = line.timestamp ?? ''
    }
    const usage = message?.usage
    if (line.type !== 'assistant' || usage === undefined || message?.model === '<synthetic>') continue
    const project = line.cwd ?? fallback
    if (meta.project === '') meta.project = project
    if (meta.start === '') meta.start = line.timestamp ?? ''
    const key = message?.id ? `${message.id}|${line.requestId ?? ''}` : `${session}|${tally.calls.size}`
    let call = tally.calls.get(key)
    if (call === undefined) {
      const creation = usage.cache_creation_input_tokens ?? 0
      const w1 = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
      call = {
        p: project, m: message?.model ?? 'unknown', d: (line.timestamp ?? '').slice(0, 10), s: session,
        f: usage.speed === 'fast',
        i: usage.input_tokens ?? 0, o: usage.output_tokens ?? 0, w5: creation - w1, w1,
        r: usage.cache_read_input_tokens ?? 0, think: 0, textChars: 0, toolChars: 0,
      }
      tally.calls.set(key, call)
    }
    call.think = Math.max(call.think, usage.output_tokens_details?.thinking_tokens ?? 0)
    const blocks = Array.isArray(message?.content) ? (message.content as { type?: string }[]) : []
    for (const block of blocks) {
      const size = JSON.stringify(block).length
      if (block.type === 'tool_use') call.toolChars += size
      else if (block.type === 'text') call.textChars += size
    }
  }
}

/** Totals the calls by project, model, day, session and speed. */
export const reportOf = (tally: Tally, scannedAt: string): Report => {
  const rows = new Map<string, UsageRow>()
  for (const c of tally.calls.values()) {
    const thinking = Math.min(c.think, c.o)
    const rest = c.o - thinking
    const shown = c.textChars + c.toolChars
    const tools = shown > 0 ? Math.round((rest * c.toolChars) / shown) : 0
    const key = [c.p, c.m, c.d, c.s, c.f].join('\t')
    const row = rows.get(key) ?? {
      p: c.p, m: c.m, d: c.d, s: c.s, f: c.f, i: 0, o: 0, w5: 0, w1: 0, r: 0, n: 0, ot: 0, ox: 0, oc: 0,
    }
    row.i += c.i; row.o += c.o; row.w5 += c.w5; row.w1 += c.w1; row.r += c.r; row.n += 1
    row.ot += thinking; row.oc += tools; row.ox += rest - tools
    rows.set(key, row)
  }

  return {
    scannedAt,
    files: tally.files,
    rows: [...rows.values()],
    sessions: [...tally.sessions.values()].filter(s => s.project !== ''),
  }
}
