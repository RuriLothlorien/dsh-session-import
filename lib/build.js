/**
 * Event builder — Host half.
 *
 * Turns the flat conversation items produced by a source adapter into the DSH
 * Session log format: turns, steps, messages, tool calls and results.
 *
 * The format has invariants the write path does not check but the read path does,
 * so they are enforced here rather than left to the log validator:
 * - an assistant message carries `surfaceOp: 'append'`;
 * - a `tool/call` is answered by a `tool/result` inside the same step, so a call
 *   whose output never landed in the transcript is dropped from the transcript;
 * - a developer message needs a producer-owned `source` and a message id;
 * - `step/end` never leaves an unanswered call behind.
 *
 * @module dsh-session-import/build
 */

import { randomUUID } from 'node:crypto'

/** Import depth levels; the browser half mirrors these numbers. */
export const GRANULARITY = { SUMMARY: 1, TALK: 2, TOOLS: 3, FULL: 4 }

/**
 * Shorten a tool output for the summary and tool detail levels.
 * @param text - raw output text.
 * @param limit - maximum characters to keep; 0 keeps everything.
 * @returns the truncated text.
 */
function truncateOutput(text, limit) {
  if (limit <= 0 || text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（共 ${text.length} 字符，已截断） / (${text.length} characters, truncated)`
}

/**
 * Keep only the trailing messages of a conversation, aligned to a user turn.
 * @param items - flattened items.
 * @param maxMessages - messages to keep; 0 keeps everything.
 * @returns the trimmed items.
 */
export function trimItems(items, maxMessages) {
  if (maxMessages <= 0) return items
  const countable = (item) => item.kind === 'message' && (item.role === 'user' || item.role === 'assistant')
  let total = 0
  for (const item of items) if (countable(item)) total += 1
  if (total <= maxMessages) return items
  let seen = 0
  let start = 0
  for (let index = 0; index < items.length; index += 1) {
    if (!countable(items[index])) continue
    if (seen >= total - maxMessages) {
      start = index
      break
    }
    seen += 1
  }
  // A transcript should open on a user turn; skip a leading assistant reply.
  while (start < items.length && !(items[start].kind === 'message' && items[start].role === 'user')) start += 1
  return items.slice(start)
}

/**
 * Group flattened items into the steps a Session log is built from.
 *
 * One model turn reaches the transcript as several consecutive records that share
 * a segment key (Claude Code splits an assistant message across lines, WorkBuddy
 * writes reasoning, calls and prose as separate records). Items carrying the same
 * segment join one assistant step; a fresh segment, or a non-assistant item, closes it.
 * @param items - flattened conversation items.
 * @param options - import depth and limits.
 * @returns ordered steps.
 */
function toSteps(items, options) {
  const granularity = options.granularity
  const steps = []
  let seenUser = false

  /** The assistant step new blocks should join, if it is still open. */
  let open = null

  const startAssistant = (when, segment) => {
    const step = { kind: 'assistant', blocks: [], calls: [], outputs: new Map(), segment, time: when }
    steps.push(step)
    open = step
    return step
  }

  const assistantStep = (when, segment) => {
    if (open !== null && (segment === undefined || open.segment === undefined || open.segment === segment)) return open
    return startAssistant(when, segment)
  }

  for (const item of items) {
    switch (item.kind) {
      case 'message': {
        if (item.role === 'user') {
          seenUser = true
          open = null
          steps.push({ kind: 'user', messages: [item.text], time: item.time })
        } else if (item.role === 'assistant') {
          assistantStep(item.time, item.segment).blocks.push({ type: 'text', text: item.text })
        } else if (granularity >= GRANULARITY.TALK && seenUser) {
          // Codex and Claude both open every transcript with their own instructions;
          // those preambles are scaffolding, so the talk level keeps only developer
          // messages that arrive once the conversation has started.
          open = null
          steps.push({ kind: 'developer', role: item.role, text: item.text, time: item.time })
        }
        break
      }
      case 'reasoning': {
        if (granularity >= GRANULARITY.FULL) assistantStep(item.time, item.segment).blocks.push({ type: 'reasoning', text: item.text })
        break
      }
      case 'call': {
        if (granularity < GRANULARITY.TOOLS) break
        const step = assistantStep(item.time, item.segment)
        if (step.calls.some((call) => call.callId === item.callId)) break
        step.calls.push({ callId: item.callId, name: item.name, arguments: item.arguments })
        step.blocks.push({ type: 'tool-call', id: item.callId, name: item.name, arguments: item.arguments })
        break
      }
      case 'output': {
        if (granularity < GRANULARITY.TOOLS) break
        // The answer may arrive after the next turn has already opened a new step,
        // so look backwards for the step that actually issued the call.
        for (let index = steps.length - 1; index >= 0; index -= 1) {
          const step = steps[index]
          if (step.kind !== 'assistant') continue
          if (step.calls.some((call) => call.callId === item.callId)) {
            step.outputs.set(item.callId, item.text)
            break
          }
        }
        break
      }
      default:
        break
    }
  }

  return steps
}

/**
 * Build the DSH Session log for one imported conversation.
 * @param items - flattened conversation items from a source adapter.
 * @param options - import depth and limits.
 * @param meta - `{ model, createdAt, title }` describing the source conversation.
 * @returns the events to append and the counters shown in the report.
 */
export function buildEvents(items, options, meta) {
  // The message cap is part of the import scale, so it has to be applied before
  // the items become steps: trimming afterwards would leave calls without output.
  const steps = toSteps(trimItems(items, options.maxMessages ?? 0), options)
  const model = meta.model === '' ? 'import' : meta.model

  const events = []
  let seq = 0
  let clock = Number.isFinite(meta.createdAt) ? meta.createdAt : Date.now()
  let firstUserSeq

  const at = (candidate) => {
    const value = Number.isFinite(candidate) ? candidate : clock
    if (value > clock) clock = value
    return clock
  }
  const push = (type, when, data, surfaceOp) => {
    const event = { type, seq: seq++, time: when, data }
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
    events.push(event)
  }

  let turn = 0
  let step = 0
  let open = false
  // The read path requires a protected first surface head: a `system/message` must be the
  // first surface node or DSH can never append an in-history system prompt to this log.
  // Such a node is reserved here, empty, so it carries a position without a wire message.
  let systemNodePlaced = false
  let assistantSeen = 0
  let toolSeen = 0
  let messageSeen = 0

  const beginTurn = (when) => {
    turn += 1
    step = 0
    open = true
    push('turn/start', when, { turn })
  }
  const endTurn = () => {
    push('turn/end', clock, { turn, reason: { kind: 'completed' } })
    open = false
  }

  for (const entry of steps) {
    if (entry.kind === 'user' && open && step > 0) endTurn()
    if (!open) beginTurn(at(entry.time))
    const when = at(entry.time)
    step += 1
    push('step/start', when, { turn, step })

    if (!systemNodePlaced) {
      systemNodePlaced = true
      const message = { role: 'system', content: [], source: { kind: 'system-prompt' }, id: randomUUID() }
      push('system/message', when, { turn, step, message }, 'append')
    }

    if (entry.kind === 'user') {
      for (const text of entry.messages) {
        messageSeen += 1
        const data = { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: randomUUID() }
        if (firstUserSeq === undefined) firstUserSeq = seq
        push('user/message', when, data, 'append')
      }
    } else if (entry.kind === 'developer') {
      const message = {
        role: 'developer',
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'system-prompt' },
        id: randomUUID(),
      }
      push('developer/message', when, { turn, step, message }, 'append')
    } else if (entry.kind === 'assistant') {
      // A step may only close over tool calls that also carry their output.
      const resolved = entry.calls.filter((call) => entry.outputs.has(call.callId))
      const resolvedIds = new Set(resolved.map((call) => call.callId))
      const content = entry.blocks.filter((block) => block.type !== 'tool-call' || resolvedIds.has(block.id))
      if (content.length > 0) {
        const message = { role: 'assistant', content, source: { kind: 'model', provider: meta.provider ?? 'import', model }, id: randomUUID() }
        push('assistant/message', when, { turn, step, message, stream: [] }, 'append')
        assistantSeen += 1
      }
      for (const call of resolved) {
        toolSeen += 1
        push('tool/call', when, { turn, step, callId: call.callId, name: call.name, arguments: call.arguments })
      }
      for (const call of resolved) {
        const text = truncateOutput(entry.outputs.get(call.callId), options.toolOutputLimit)
        const data = {
          turn,
          step,
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: call.callId },
            toolCallId: call.callId,
            content: [{ type: 'text', text }],
            id: randomUUID(),
          },
        }
        push('tool/result', when, data, 'append')
      }
    }
    push('step/end', when, { turn, step })
  }
  if (open) endTurn()

  if (firstUserSeq !== undefined && meta.title !== '') {
    events.push({ type: 'session/title', seq: seq++, time: clock, data: { title: meta.title, messageSeqs: [firstUserSeq], source: { kind: 'fallback' } } })
  }

  return { events, model, counters: { turns: turn, assistantMessages: assistantSeen, toolCalls: toolSeen, userMessages: messageSeen } }
}
