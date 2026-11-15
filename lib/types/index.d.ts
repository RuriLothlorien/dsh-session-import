/**
 * Type surface for the session import bundle.
 *
 * The package is authored in plain JavaScript, so these declarations describe the
 * one exported Host entry point and the row configuration it reads. The browser
 * half is a `window.__ModuleLoader__` artifact and is never imported by TypeScript.
 *
 * @module dsh-session-import
 */

/** Row configuration, read from this bundle's patch or a profile override. */
export interface SessionImportConfig {
  /**
   * Codex home directory. An empty or omitted value resolves `$CODEX_HOME`, then
   * `~/.codex`.
   */
  codexHome?: string
  /**
   * Claude Code home directory, which also holds the transcripts Claude Desktop
   * writes through the same engine. An empty or omitted value resolves
   * `$CLAUDE_CONFIG_DIR`, then `~/.claude`.
   */
  claudeHome?: string
  /**
   * WorkBuddy home directory. An empty or omitted value resolves
   * `$WORKBUDDY_HOME`, then `~/.workbuddy`.
   */
  workbuddyHome?: string
  /**
   * Characters kept from one tool output at the `tools` detail level. `0` keeps
   * every character (the `full` level does that regardless of this value).
   */
  toolOutputLimit?: number
  /**
   * Create the Workspace for an imported session's directory when none matches
   * yet. Defaults to `true`; `false` leaves such a session ungrouped.
   */
  createWorkspace?: boolean
  /**
   * Resume each imported session after writing it, so clients receive
   * `api-session/added` with a computed title. Defaults to `true`; `false` leaves
   * the session visible only after the next Host start.
   */
  publishSessions?: boolean
}

/** One conversation item a source adapter produces; the builder consumes these. */
export interface ConversationItem {
  /** `message` carries a role, `reasoning` prose, `call` a tool call, `output` its result. */
  kind: 'message' | 'reasoning' | 'call' | 'output'
  /** Present on `message` items. */
  role?: 'user' | 'assistant' | 'developer' | 'system'
  /** Present on `message`, `reasoning` and `output` items. */
  text?: string
  /** Present on `call` and `output` items. */
  callId?: string
  /** Present on `call` items. */
  name?: string
  /** Present on `call` items; always a string, as the log format carries text. */
  arguments?: string
  /** Epoch milliseconds, or `NaN` when the record carried no usable timestamp. */
  time: number
  /** Groups the records of one model turn into a single step. */
  segment?: string
}

/** One scanned conversation, as the panel receives it. */
export interface ScanEntry {
  source: 'codex' | 'claude' | 'workbuddy'
  /** Client display label, which for Claude distinguishes Desktop from Code. */
  client: string
  id: string
  path: string
  fileName: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  bytes: number
  model: string
  archived: boolean
  userMessages: number
  assistantMessages: number
  developerMessages: number
  toolCalls: number
  toolOutputs: number
  reasoning: number
  /** Set by the scan when a Session already holds this conversation. */
  importedSessionId?: string | null
  /**
   * How many transcript files were folded into this entry. A Codex thread writes a
   * new continuation log on every resume and a WorkBuddy resend fork does the same,
   * so the largest file of the group stands for the whole conversation. Absent or
   * `1` means one file.
   */
  variants?: number
}

/** Host services this bundle waits for before it activates. */
export declare const inject: readonly ['webServer', 'sessionPersistence', 'connection']

/**
 * The row schema the settings form reads and writes back.
 *
 * Declared so a field this bundle honours is never dropped by a save from that
 * form, and so a mistyped value fails the load instead of being ignored.
 */
export declare const Config: unknown

/**
 * Mount the Host half: scan endpoints and the transcript-to-session importer.
 * @param ctx - the Cordis context the Loader hands to a bundle row.
 * @param config - the row configuration, already merged from the profile layers.
 */
export declare function apply(ctx: unknown, config?: SessionImportConfig): void
