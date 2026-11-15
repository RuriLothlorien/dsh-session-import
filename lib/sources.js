/**
 * Session sources — Host half.
 *
 * Every supported client keeps its transcripts in its own home directory and its
 * own record schema. This module turns each of them into one shape: an ordered
 * list of conversation items (`message` / `reasoning` / `call` / `output`) plus
 * the metadata the panel needs to describe a session before importing it.
 *
 * Adapters are pure readers. Nothing here writes Session logs.
 *
 * @module dsh-session-import/sources
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

/** Title fallback length, shared by every adapter. */
const TITLE_LIMIT = 72
/** Shown when a transcript carries no title and no user text to derive one from. */
const UNTITLED = '(无标题会话 / Untitled session)'
/** Directory recursion budget below a source root. */
const WALK_DEPTH = 5
/** Directories that hold derived or nested-agent transcripts, never sessions. */
const DERIVED_DIRECTORIES = new Set(['subagents', 'tool-results', 'workflows', 'node_modules'])

/* ------------------------------------------------------------------ shared -- */

/**
 * Resolve a source home directory: explicit config, then its environment variable,
 * then the conventional directory under the user profile.
 * @param configured - the row's config value.
 * @param envName - environment variable consulted when config is empty.
 * @param fallback - directory name under the user profile.
 * @returns an absolute directory path.
 */
function resolveHome(configured, envName, fallback) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnvironment = process.env[envName]
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') return fromEnvironment.trim()
  return join(homedir(), fallback)
}

/**
 * List transcript files below one directory, bounded by depth.
 * @param directory - directory to walk.
 * @param depth - remaining recursion budget.
 * @param into - collector of absolute paths.
 */
async function walkJsonl(directory, depth, into) {
  if (depth < 0) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!DERIVED_DIRECTORIES.has(entry.name)) await walkJsonl(path, depth - 1, into)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      into.push(path)
    }
  }
}

/**
 * Read and parse a JSONL transcript, tolerating a torn tail.
 * @param path - absolute file path.
 * @returns `{ text, records }` where `records` holds only decodable lines.
 */
async function readJsonLines(path) {
  const text = await readFile(path, 'utf8')
  const records = []
  for (const line of text.split('\n')) {
    if (line === '' || line[0] !== '{') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A record still being written by a live client is simply skipped.
    }
  }
  return { text, records }
}

/**
 * Join every text part of a content value.
 * @param content - a string, or an array of typed parts carrying `text`.
 * @returns the joined text, or an empty string.
 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * Collapse one line of prose into a single-line title.
 * @param text - message text.
 * @returns a short title.
 */
function titleFromText(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= TITLE_LIMIT) return collapsed
  return `${collapsed.slice(0, TITLE_LIMIT - 1)}…`
}

/**
 * Build the empty per-session counter block.
 * @returns zeroed counters.
 */
function emptyCounts() {
  return { userMessages: 0, assistantMessages: 0, developerMessages: 0, toolCalls: 0, toolOutputs: 0, reasoning: 0 }
}

/**
 * Read one file's size, tolerating a file that vanished between listing and reading.
 * @param path - absolute file path.
 * @returns the size in bytes, or `undefined`.
 */
async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}

/**
 * Assemble the scan result for one source.
 * @param id - source id.
 * @param label - display label.
 * @param root - the directory the source was read from.
 * @param sessions - described sessions.
 * @param warnings - per-file parse problems worth reporting.
 * @param skipped - per-reason skip counters.
 * @param files - number of transcript files seen.
 * @returns the source result the orchestrator merges.
 */
function sourceResult(id, label, root, sessions, warnings, skipped, files) {
  return {
    id,
    label,
    root,
    available: skipped.missing !== files || files > 0,
    sessions,
    warnings,
    skipped,
    stats: { files, sessions: sessions.length, bytes: sessions.reduce((sum, session) => sum + session.bytes, 0) },
  }
}

/**
 * Collapse the transcripts that describe one and the same conversation.
 *
 * A Codex thread keeps growing into continuation logs that all carry the thread
 * id, so one conversation can own several files; a resend fork in WorkBuddy does
 * the same. Listing them separately would offer the same exchange twice and, worse,
 * let the shorter file win a selection, so one entry per conversation survives:
 * the largest file, which is the one holding the whole transcript. `variants`
 * records how many files were folded into it.
 * @param sessions - described sessions, possibly with repeats.
 * @returns one entry per conversation, newest first.
 */
function collapseVariants(sessions) {
  const grouped = new Map()
  for (const session of sessions) {
    const key = `${session.source}:${session.id}`
    const list = grouped.get(key)
    if (list === undefined) grouped.set(key, [session])
    else list.push(session)
  }
  const unique = []
  for (const list of grouped.values()) {
    list.sort((left, right) => right.bytes - left.bytes || right.updatedAt - left.updatedAt)
    unique.push({ ...list[0], variants: list.length })
  }
  unique.sort((left, right) => right.updatedAt - left.updatedAt)
  return unique
}

/* ------------------------------------------------------------------- codex -- */

/** Suffixes that mark harness-injected user turns rather than the user's own words. */
const CODEX_INJECTED_PREFIXES = ['<environment_context>', '<user_instructions>', '# AGENTS.md instructions', '<permissions instructions>']

/**
 * Read the title index Codex keeps beside its rollout directories.
 * @param home - Codex home directory.
 * @returns thread id to thread name.
 */
async function readCodexThreadNames(home) {
  const names = new Map()
  let text
  try {
    text = await readFile(join(home, 'session_index.jsonl'), 'utf8')
  } catch {
    return names
  }
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const record = JSON.parse(line)
      if (typeof record.id === 'string' && typeof record.thread_name === 'string') names.set(record.id, record.thread_name)
    } catch {
      // A torn or foreign line is not worth failing the scan over.
    }
  }
  return names
}

/**
 * Count the message-bearing record kinds of one rollout without parsing every line.
 * @param lines - rollout lines.
 * @returns the counters the panel renders and the scale estimate uses.
 */
function countCodexRecords(lines) {
  const counts = emptyCounts()
  for (const line of lines) {
    if (line.length < 24 || !line.includes('"response_item"')) continue
    if (line.includes('"type":"message"')) {
      if (line.includes('"role":"user"')) counts.userMessages += 1
      else if (line.includes('"role":"assistant"')) counts.assistantMessages += 1
      else if (line.includes('"role":"developer"') || line.includes('"role":"system"')) counts.developerMessages += 1
      continue
    }
    if (line.includes('"type":"function_call_output"') || line.includes('"type":"custom_tool_call_output"')) counts.toolOutputs += 1
    else if (line.includes('"type":"function_call"') || line.includes('"type":"custom_tool_call"')) counts.toolCalls += 1
    else if (line.includes('"type":"reasoning"')) counts.reasoning += 1
  }
  return counts
}

/**
 * Join a Codex reasoning summary and any plaintext reasoning content.
 * @param payload - a `reasoning` response item.
 * @returns the joined text, or an empty string for encrypted-only reasoning.
 */
function codexReasoningText(payload) {
  const parts = []
  if (Array.isArray(payload.summary)) {
    for (const entry of payload.summary) if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string') parts.push(entry.text)
  }
  if (Array.isArray(payload.content)) {
    for (const entry of payload.content) if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string') parts.push(entry.text)
  }
  return parts.join('\n')
}

/**
 * Describe one Codex rollout for the session list.
 * @param path - absolute rollout path.
 * @param home - Codex home directory.
 * @param names - thread id to thread name.
 * @returns `{ entry }` for a readable rollout, or `{ skip }` naming why it was refused.
 */
async function describeCodexRollout(path, home, names) {
  const bytes = await sizeOf(path)
  if (bytes === undefined) return { skip: 'missing' }
  if (bytes === 0) return { skip: 'empty' }

  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return { skip: 'unreadable', detail: error instanceof Error ? error.message : String(error) }
  }
  // Codex rollouts are UTF-8 JSON; anything else is a foreign or encrypted file.
  if (text[0] !== '{') return { skip: 'foreign' }

  const lines = text.split('\n').filter((line) => line !== '')
  let meta
  try {
    const head = JSON.parse(lines[0])
    if (head.type !== 'session_meta' || head.payload === null || typeof head.payload !== 'object') return { skip: 'foreign' }
    meta = head.payload
  } catch {
    return { skip: 'foreign' }
  }

  const threadId = typeof meta.id === 'string' ? meta.id : typeof meta.session_id === 'string' ? meta.session_id : ''
  if (threadId === '') return { skip: 'foreign' }

  const createdAt = typeof meta.timestamp === 'string' ? Date.parse(meta.timestamp) : Number.NaN
  let title = names.get(threadId)
  if (title === undefined) {
    for (const line of lines.slice(0, 400)) {
      if (!line.includes('"role":"user"')) continue
      try {
        const record = JSON.parse(line)
        const payload = record.payload
        if (payload === null || typeof payload !== 'object' || payload.type !== 'message' || payload.role !== 'user') continue
        const candidate = contentText(payload.content)
        const head = candidate.trimStart()
        if (candidate.trim() === '' || CODEX_INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix))) continue
        title = titleFromText(candidate)
        break
      } catch {
        // Try the next candidate line.
      }
    }
  }

  return {
    entry: {
      source: 'codex',
      client: 'Codex',
      id: threadId,
      path,
      fileName: relative(home, path),
      title: typeof title === 'string' && title.trim() !== '' ? title.trim() : UNTITLED,
      cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updatedAt: (await stat(path)).mtimeMs,
      bytes,
      model: typeof meta.model_provider === 'string' ? meta.model_provider : '',
      archived: path.includes('archived_sessions'),
      ...countCodexRecords(lines),
    },
  }
}

/**
 * Flatten the response items of one Codex rollout into conversation items.
 * @param records - parsed rollout records.
 * @param fallbackModel - model name to attribute assistant messages to.
 * @returns ordered items plus the model observed in the log.
 */
function codexItems(records, fallbackModel) {
  const items = []
  let model = fallbackModel
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    if (record.type === 'turn_context' && record.payload !== null && typeof record.payload === 'object') {
      if (typeof record.payload.model === 'string' && record.payload.model !== '') model = record.payload.model
      continue
    }
    if (record.type !== 'response_item' || record.payload === null || typeof record.payload !== 'object') continue
    const payload = record.payload
    switch (payload.type) {
      case 'message': {
        const text = contentText(payload.content)
        if (text.trim() === '') break
        const role = payload.role
        if (role !== 'user' && role !== 'assistant' && role !== 'developer' && role !== 'system') break
        // Codex opens a rollout by replaying the instructions it was started with,
        // and some of that preamble arrives with `role: 'user'`. Nobody typed it, so
        // it is context rather than a turn of the conversation.
        const injected = role === 'user' && CODEX_INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix))
        items.push({ kind: 'message', role: injected ? 'developer' : role, text, time })
        break
      }
      case 'reasoning': {
        const text = codexReasoningText(payload)
        if (text.trim() !== '') items.push({ kind: 'reasoning', text, time })
        break
      }
      case 'function_call':
      case 'custom_tool_call': {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
        const name = typeof payload.name === 'string' ? payload.name : 'tool'
        const args = typeof payload.arguments === 'string' ? payload.arguments : typeof payload.input === 'string' ? payload.input : '{}'
        if (callId !== '') items.push({ kind: 'call', callId, name, arguments: args, time })
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
        if (callId === '') break
        items.push({ kind: 'output', callId, text: contentText(payload.output), time })
        break
      }
      default:
        break
    }
  }
  return { items, model }
}

/** Codex rollouts: `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` plus archived copies. */
const codex = {
  id: 'codex',
  label: 'Codex',
  configKey: 'codexHome',
  resolveRoot: (config) => resolveHome(config?.codexHome, 'CODEX_HOME', '.codex'),
  async scan(root) {
    const names = await readCodexThreadNames(root)
    const files = []
    for (const directory of ['sessions', 'archived_sessions']) await walkJsonl(join(root, directory), WALK_DEPTH, files)

    const sessions = []
    const warnings = []
    const skipped = { total: 0, empty: 0, unreadable: 0, foreign: 0, missing: 0 }
    for (const file of files) {
      const described = await describeCodexRollout(file, root, names)
      if (described.entry === undefined) {
        skipped.total += 1
        skipped[described.skip] += 1
        if (described.detail !== undefined) warnings.push(`${relative(root, file)}: ${described.detail}`)
        continue
      }
      sessions.push(described.entry)
    }
    // One Codex thread writes a new log on every continuation, all carrying the
    // same thread id; keep the complete one instead of offering each copy.
    return sourceResult('codex', codex.label, root, collapseVariants(sessions), warnings, skipped, files.length)
  },
  read: async (path) => (await readJsonLines(path)).records,
  toItems: (records, entry) => codexItems(records, entry.model === '' ? 'codex' : entry.model),
}

/* ------------------------------------------------------------------ claude -- */

/** Harness-injected user records carry this flag instead of user prose. */
const CLAUDE_TOOL_RESULT = 'tool_result'

/**
 * Every content block of one Claude record.
 * @param record - a `user` or `assistant` record.
 * @returns the content as an array of blocks (a bare string is wrapped as text).
 */
function claudeBlocks(record) {
  const content = record?.message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

/**
 * Read the thread titles Claude Code writes as separate records.
 * @param records - parsed records.
 * @returns the best title found, or an empty string.
 */
function claudeTitle(records) {
  let custom = ''
  let generated = ''
  for (const record of records) {
    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim() !== '') custom = record.customTitle.trim()
    else if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim() !== '') generated = record.aiTitle.trim()
  }
  return custom !== '' ? custom : generated
}

/**
 * Describe one Claude Code transcript for the session list.
 *
 * Claude Code splits a single assistant message across several consecutive lines
 * that share `message.id`, so message counts are taken per id rather than per line.
 * @param path - absolute transcript path.
 * @param root - the `projects` directory the file was found under.
 * @returns `{ entry }` or `{ skip }`.
 */
async function describeClaudeTranscript(path, root) {
  const bytes = await sizeOf(path)
  if (bytes === undefined) return { skip: 'missing' }
  if (bytes === 0) return { skip: 'empty' }

  let records
  try {
    records = (await readJsonLines(path)).records
  } catch (error) {
    return { skip: 'unreadable', detail: error instanceof Error ? error.message : String(error) }
  }
  if (records.length === 0) return { skip: 'foreign' }

  const counts = emptyCounts()
  const assistantIds = new Set()
  let sessionId = ''
  let cwd = ''
  let model = ''
  let entrypoint = ''
  let createdAt = Number.NaN
  let firstUserText = ''
  let recognised = 0

  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    if (sessionId === '' && typeof record.sessionId === 'string') sessionId = record.sessionId
    if (cwd === '' && typeof record.cwd === 'string' && record.cwd !== '') cwd = record.cwd
    if (entrypoint === '' && typeof record.entrypoint === 'string') entrypoint = record.entrypoint
    if (!Number.isFinite(createdAt) && typeof record.timestamp === 'string') createdAt = Date.parse(record.timestamp)

    // A sub-agent thread is replayed inside its parent; importing both would double it.
    if (record.isSidechain === true) continue

    if (record.type === 'assistant') {
      recognised += 1
      if (typeof record.message?.id === 'string') assistantIds.add(record.message.id)
      if (typeof record.message?.model === 'string' && record.message.model !== '' && record.message.model !== '<synthetic>') model = record.message.model
      for (const block of claudeBlocks(record)) {
        if (block?.type === 'tool_use') counts.toolCalls += 1
        else if (block?.type === 'thinking') counts.reasoning += 1
      }
      continue
    }
    if (record.type === 'user') {
      recognised += 1
      for (const block of claudeBlocks(record)) {
        if (block?.type === CLAUDE_TOOL_RESULT) counts.toolOutputs += 1
        else if (block?.type === 'text' && record.isMeta !== true) {
          counts.userMessages += 1
          if (firstUserText === '' && typeof block.text === 'string') firstUserText = block.text
        }
      }
      if (record.isMeta === true) counts.developerMessages += 1
      continue
    }
    if (record.type === 'attachment') counts.developerMessages += 1
  }

  if (recognised === 0) return { skip: 'foreign' }
  counts.assistantMessages = assistantIds.size
  if (sessionId === '') sessionId = path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '') ?? ''
  if (sessionId === '') return { skip: 'foreign' }

  const title = claudeTitle(records)
  return {
    entry: {
      source: 'claude',
      client: entrypoint === 'claude-desktop-3p' ? 'Claude Desktop' : 'Claude Code',
      id: sessionId,
      path,
      fileName: relative(root, path),
      title: title !== '' ? title : firstUserText !== '' ? titleFromText(firstUserText) : UNTITLED,
      cwd,
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updatedAt: (await stat(path)).mtimeMs,
      bytes,
      model,
      archived: false,
      ...counts,
    },
  }
}

/**
 * Flatten one Claude Code transcript into conversation items.
 *
 * Records are a flat event stream: assistant prose and tool calls arrive as
 * separate lines sharing `message.id`, every tool call is answered by a `user`
 * record carrying a `tool_result` block.
 * @param records - parsed transcript records.
 * @param entry - the scan entry (model fallback).
 * @returns ordered items plus the model observed in the log.
 */
function claudeItems(records, entry) {
  const items = []
  let model = entry.model === '' ? 'claude' : entry.model
  let unknown = 0

  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    if (record.isSidechain === true) continue
    const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN

    if (record.type === 'assistant') {
      if (typeof record.message?.model === 'string' && record.message.model !== '' && record.message.model !== '<synthetic>') model = record.message.model
      // One model turn writes several lines under the same message id; the segment
      // key lets the event builder keep them in a single step.
      const segment = typeof record.message?.id === 'string' ? record.message.id : undefined
      for (const block of claudeBlocks(record)) {
        if (block?.type === 'text') {
          if (typeof block.text === 'string' && block.text.trim() !== '') items.push({ kind: 'message', role: 'assistant', text: block.text, time, segment })
        } else if (block?.type === 'thinking') {
          const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : ''
          if (text.trim() !== '') items.push({ kind: 'reasoning', text, time, segment })
        } else if (block?.type === 'tool_use') {
          const callId = typeof block.id === 'string' ? block.id : ''
          if (callId === '') continue
          const name = typeof block.name === 'string' ? block.name : 'tool'
          const args = typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {})
          items.push({ kind: 'call', callId, name, arguments: args, time, segment })
        }
      }
      continue
    }

    if (record.type === 'user') {
      for (const block of claudeBlocks(record)) {
        if (block?.type === CLAUDE_TOOL_RESULT) {
          const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
          if (callId !== '') items.push({ kind: 'output', callId, text: contentText(block.content), time })
        } else if (block?.type === 'text') {
          const text = typeof block.text === 'string' ? block.text : ''
          if (text.trim() === '') continue
          if (record.isMeta === true) items.push({ kind: 'message', role: 'developer', text, time })
          else items.push({ kind: 'message', role: 'user', text, time })
        }
      }
      continue
    }

    if (record.type === 'attachment' && record.attachment !== null && typeof record.attachment === 'object') {
      const attachment = record.attachment
      const kind = typeof attachment.type === 'string' ? attachment.type : 'attachment'
      const text = contentText(attachment.content)
      if (text.trim() !== '') items.push({ kind: 'message', role: 'developer', text: `[${kind}]\n${text}`, time })
      continue
    }

    unknown += 1
  }

  return { items, model, unknown }
}

/** Claude Code and Claude Desktop transcripts: `<home>/projects/<slug>/<id>.jsonl`. */
const claude = {
  id: 'claude',
  label: 'Claude',
  configKey: 'claudeHome',
  resolveRoot: (config) => resolveHome(config?.claudeHome, 'CLAUDE_CONFIG_DIR', '.claude'),
  async scan(root) {
    const directory = join(root, 'projects')
    const files = []
    await walkJsonl(directory, WALK_DEPTH, files)

    const sessions = []
    const warnings = []
    const skipped = { total: 0, empty: 0, unreadable: 0, foreign: 0, missing: 0 }
    for (const file of files) {
      const described = await describeClaudeTranscript(file, directory)
      if (described.entry === undefined) {
        skipped.total += 1
        skipped[described.skip] += 1
        if (described.detail !== undefined) warnings.push(`${relative(directory, file)}: ${described.detail}`)
        continue
      }
      sessions.push(described.entry)
    }
    return sourceResult('claude', claude.label, directory, collapseVariants(sessions), warnings, skipped, files.length)
  },
  read: async (path) => (await readJsonLines(path)).records,
  toItems: claudeItems,
}

/* --------------------------------------------------------------- workbuddy -- */

/** Harness context blocks WorkBuddy wraps around the user's own words. */
const WB_SYSTEM_REMINDER = /<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>/g
/** Background-task notifications are tool bookkeeping, not conversation. */
const WB_TASK_NOTIFICATION = /<task-notification(?:\s[^>]*)?>[\s\S]*?<\/task-notification>/g
/** Wrappers that carry scheduled-task boilerplate rather than the user's own words. */
const WB_AUTOMATION_REMINDER = /<automation_system_reminder(?:\s[^>]*)?>[\s\S]*?<\/automation_system_reminder>/g
/** One prompt tag, matched by scanning rather than by regular expression. */
const WB_USER_QUERY_OPEN = '<user_query>'
const WB_USER_QUERY_CLOSE = '</user_query>'

/**
 * Collect the text of every `<user_query>` element.
 *
 * A plain non-greedy match is wrong here: the automation wrapper explains itself
 * with the sentence "the task instructions are provided in <user_query>.", so the
 * tag name also appears as prose. Pairing each close tag with the nearest open tag
 * before it skips that mention and keeps the prompt that follows it.
 * @param text - raw record text.
 * @returns the prompts found, in order.
 */
function workbuddyQueries(text) {
  const queries = []
  const opens = []
  for (let index = text.indexOf(WB_USER_QUERY_OPEN); index !== -1; index = text.indexOf(WB_USER_QUERY_OPEN, index + 1)) opens.push(index)
  if (opens.length === 0) return queries
  let cursor = 0
  while (cursor < text.length) {
    const close = text.indexOf(WB_USER_QUERY_CLOSE, cursor)
    if (close === -1) break
    let open = -1
    for (const index of opens) {
      if (index < close && index > open) open = index
    }
    if (open !== -1) {
      const value = text.slice(open + WB_USER_QUERY_OPEN.length, close)
      if (value.trim() !== '') queries.push(value)
    }
    cursor = close + WB_USER_QUERY_CLOSE.length
  }
  return queries
}

/**
 * Recover the user's own words from a WorkBuddy user record.
 *
 * A record may carry the workspace reminder, the identity files, the current time
 * and the prompt together. The tagged prompt wins when present; otherwise the
 * known context wrappers are removed and whatever remains is the user's text.
 * @param text - raw record text.
 * @returns the user's prompt, or an empty string for a context-only record.
 */
function workbuddyUserText(text) {
  const queries = workbuddyQueries(text)
  if (queries.length > 0) return queries.join('\n\n').trim()
  const rest = text.replace(WB_SYSTEM_REMINDER, '').replace(WB_TASK_NOTIFICATION, '').replace(WB_AUTOMATION_REMINDER, '')
  return rest.trim()
}

/**
 * Describe one WorkBuddy transcript for the session list.
 * @param path - absolute transcript path.
 * @param root - the `projects` directory the file was found under.
 * @returns `{ entry }` or `{ skip }`.
 */
async function describeWorkbuddyTranscript(path, root) {
  const bytes = await sizeOf(path)
  if (bytes === undefined) return { skip: 'missing' }
  if (bytes === 0) return { skip: 'empty' }

  let records
  try {
    records = (await readJsonLines(path)).records
  } catch (error) {
    return { skip: 'unreadable', detail: error instanceof Error ? error.message : String(error) }
  }
  if (records.length === 0) return { skip: 'foreign' }

  const counts = emptyCounts()
  let sessionId = ''
  let cwd = ''
  let model = ''
  let title = ''
  let createdAt = Number.NaN
  let firstUserText = ''
  let recognised = 0

  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    if (sessionId === '' && typeof record.sessionId === 'string') sessionId = record.sessionId
    if (cwd === '' && typeof record.cwd === 'string' && record.cwd !== '') cwd = record.cwd
    if (!Number.isFinite(createdAt) && Number.isFinite(record.timestamp)) createdAt = record.timestamp

    switch (record.type) {
      case 'message': {
        recognised += 1
        const text = contentText(record.content)
        if (record.role === 'user') {
          const prompt = workbuddyUserText(text)
          if (prompt !== '') {
            counts.userMessages += 1
            if (firstUserText === '') firstUserText = prompt
          } else {
            counts.developerMessages += 1
          }
        } else if (record.role === 'assistant') {
          if (text.trim() !== '') counts.assistantMessages += 1
          if (typeof record.providerData?.model === 'string' && record.providerData.model !== '') model = record.providerData.model
        }
        break
      }
      case 'reasoning': {
        recognised += 1
        counts.reasoning += 1
        break
      }
      case 'function_call': {
        recognised += 1
        counts.toolCalls += 1
        break
      }
      case 'function_call_result': {
        recognised += 1
        counts.toolOutputs += 1
        break
      }
      case 'ai-title': {
        if (typeof record.aiTitle === 'string' && record.aiTitle.trim() !== '') title = record.aiTitle.trim()
        break
      }
      case 'session-meta': {
        // The meta row may repeat the title the client already generated.
        const carried = record.meta?.['codebuddy.ai/sessionTitle']
        if (title === '' && Array.isArray(carried)) {
          for (const entry of carried) if (typeof entry?.aiTitle === 'string' && entry.aiTitle.trim() !== '') title = entry.aiTitle.trim()
        }
        break
      }
      default:
        break
    }
  }

  if (recognised === 0) return { skip: 'foreign' }
  if (sessionId === '') sessionId = path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '') ?? ''
  if (sessionId === '') return { skip: 'foreign' }

  return {
    entry: {
      source: 'workbuddy',
      client: 'WorkBuddy',
      id: sessionId,
      path,
      fileName: relative(root, path),
      title: title !== '' ? title : firstUserText !== '' ? titleFromText(firstUserText) : UNTITLED,
      cwd,
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updatedAt: (await stat(path)).mtimeMs,
      bytes,
      model,
      archived: false,
      ...counts,
    },
  }
}

/**
 * Flatten one WorkBuddy transcript into conversation items.
 * @param records - parsed transcript records.
 * @param entry - the scan entry (model fallback).
 * @returns ordered items plus the model observed in the log.
 */
function workbuddyItems(records, entry) {
  const items = []
  let model = entry.model === '' ? 'workbuddy' : entry.model

  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    const time = Number.isFinite(record.timestamp) ? record.timestamp : Number.NaN
    // One model turn writes its reasoning, its calls and its prose under the same
    // provider message id, which is the grouping key the event builder needs.
    const segment = typeof record.providerData?.messageId === 'string' ? record.providerData.messageId : undefined

    switch (record.type) {
      case 'message': {
        if (record.role === 'user') {
          const text = contentText(record.content)
          const prompt = workbuddyUserText(text)
          if (prompt !== '') items.push({ kind: 'message', role: 'user', text: prompt, time })
          break
        }
        if (record.role !== 'assistant') break
        if (typeof record.providerData?.model === 'string' && record.providerData.model !== '') model = record.providerData.model
        const text = contentText(record.content)
        if (text.trim() !== '') items.push({ kind: 'message', role: 'assistant', text, time, segment: typeof record.id === 'string' ? record.id : segment })
        break
      }
      case 'reasoning': {
        const parts = []
        for (const block of Array.isArray(record.rawContent) ? record.rawContent : []) {
          if (typeof block?.text === 'string' && block.text.trim() !== '') parts.push(block.text)
        }
        for (const block of Array.isArray(record.content) ? record.content : []) {
          if (typeof block?.text === 'string' && block.text.trim() !== '') parts.push(block.text)
        }
        const text = parts.join('\n')
        if (text.trim() !== '') items.push({ kind: 'reasoning', text, time, segment })
        break
      }
      case 'function_call': {
        const callId = typeof record.callId === 'string' ? record.callId : typeof record.id === 'string' ? record.id : ''
        if (callId === '') break
        const name = typeof record.name === 'string' ? record.name : 'tool'
        const args = typeof record.arguments === 'string' ? record.arguments : JSON.stringify(record.arguments ?? {})
        items.push({ kind: 'call', callId, name, arguments: args, time, segment })
        break
      }
      case 'function_call_result': {
        const callId = typeof record.callId === 'string' ? record.callId : ''
        if (callId === '') break
        const output = record.output
        const text = Array.isArray(output) ? contentText(output) : contentText(output?.text ?? output?.content ?? '')
        items.push({ kind: 'output', callId, text, time })
        break
      }
      default:
        break
    }
  }

  return { items, model }
}

/** WorkBuddy transcripts: `<home>/projects/<slug>/<sessionId>.jsonl`. */
const workbuddy = {
  id: 'workbuddy',
  label: 'WorkBuddy',
  configKey: 'workbuddyHome',
  resolveRoot: (config) => resolveHome(config?.workbuddyHome, 'WORKBUDDY_HOME', '.workbuddy'),
  async scan(root) {
    const directory = join(root, 'projects')
    const files = []
    await walkJsonl(directory, WALK_DEPTH, files)

    const sessions = []
    const warnings = []
    const skipped = { total: 0, empty: 0, unreadable: 0, foreign: 0, missing: 0 }
    for (const file of files) {
      const described = await describeWorkbuddyTranscript(file, directory)
      if (described.entry === undefined) {
        skipped.total += 1
        skipped[described.skip] += 1
        if (described.detail !== undefined) warnings.push(`${relative(directory, file)}: ${described.detail}`)
        continue
      }
      sessions.push(described.entry)
    }
    return sourceResult('workbuddy', workbuddy.label, directory, collapseVariants(sessions), warnings, skipped, files.length)
  },
  read: async (path) => (await readJsonLines(path)).records,
  toItems: workbuddyItems,
}

/* --------------------------------------------------------------- registry -- */

/** Every source this build can read, in panel order. */
export const SOURCES = [codex, claude, workbuddy]

/**
 * Look one source up by id.
 * @param id - `codex`, `claude` or `workbuddy`.
 * @returns the adapter, or `undefined` for an unknown id.
 */
export function sourceById(id) {
  return SOURCES.find((source) => source.id === id)
}

/**
 * Derive the DSH Session id an imported conversation is stored under.
 *
 * Codex keeps the bare thread id because earlier builds already wrote Sessions
 * under that name; the newer sources are namespaced so two clients that happen to
 * use the same UUID cannot collide.
 * @param source - source id.
 * @param id - the source's own conversation id.
 * @returns the Session id.
 */
export function sessionIdFor(source, id) {
  return source === 'codex' ? `session-${id}` : `session-${source}-${id}`
}
