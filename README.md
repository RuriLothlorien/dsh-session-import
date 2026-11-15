# dsh-session-import

Import conversations from **Codex**, **Claude Code / Claude Desktop** and **WorkBuddy** into DeepSeek Harness as ordinary DSH sessions.

The bundle adds one entry to the sidebar. Its page lists every conversation it can find on this machine, and you choose how much of each one to bring across: a time window, projects, an optional message cap, and a four-level granularity.

[中文说明](README.zh.md)

## What it reads

| Client | Directory | Files |
| --- | --- | --- |
| Codex | `$CODEX_HOME` or `~/.codex` | `sessions/YYYY/MM/DD/rollout-*.jsonl`, `archived_sessions/`, titles from `session_index.jsonl` |
| Claude Code | `$CLAUDE_CONFIG_DIR` or `~/.claude` | `projects/<slug>/<session-id>.jsonl` |
| Claude Desktop | the same Claude directory | the desktop app drives the same engine, so its conversations are those transcripts whose `entrypoint` is `claude-desktop-3p`; the list labels them *Claude Desktop* |
| WorkBuddy | `$WORKBUDDY_HOME` or `~/.workbuddy` | `projects/<slug>/<session-id>.jsonl` |

Each directory is read only. Nothing is rewritten, moved, or deleted.

Files that cannot be parsed are counted and reported rather than treated as failures — that covers the encrypted rollouts a data-loss-prevention agent writes, in-flight files, and empty placeholders.

One conversation can own several files: Codex writes a continuation log on every resume carrying the same thread id, and a WorkBuddy resend fork does the same. Those files are folded into one row — the largest one, which replays the earlier transcript in full — and the row marks how many were folded (`×2`, `×3`). Nothing is stitched together, so the conversation is neither lost nor duplicated.

## Granularity

Every level contains everything the level above it does.

| Level | Contains |
| --- | --- |
| L1 摘要 / summary | user and assistant prose |
| L2 对话 / talk | plus the developer and system notes the client injected once the conversation had started |
| L3 工具 / tools | plus tool calls and their outputs, truncated to `toolOutputLimit` |
| L4 完整 / full | plus reasoning, and tool outputs in full |

The message cap keeps the most recent *n* messages of a conversation and aligns the result to a user turn, so a trimmed import still opens on something the user said.

The opening instructions a client replays at the start of a transcript are scaffolding, not conversation: at L2 and above they are kept only after the first real user turn.

## What an import produces

Each selected conversation becomes a real DSH session:

- it is stored in the normal session directory, so it survives a Host restart;
- it joins the Workspace that owns the conversation's original directory, and a Workspace is created when none matches (`createWorkspace`);
- it is resumed once after writing (`publishSessions`), which is what makes the sidebar row, its title, and further conversation available immediately instead of after a restart;
- one log line per event, in the format the read path validates, so a broken write is reported at import time rather than when you open the session.

A second import of the same conversation is skipped. Enable *write a copy* to import it again at a different granularity; the copy gets a numeric suffix. Re-importing without a copy still repairs grouping and publication, which is what the **修复分组 / Repair grouping** button does.

Conversation ids are namespaced per source (`session-claude-<id>`, `session-workbuddy-<id>`), except Codex, which keeps `session-<id>` so sessions written by earlier builds stay attached to their transcripts.

## Install

Point the profile at a release asset — the packed bundle, not a checkout:

```bash
dsh plugin install https://github.com/RuriLothlorien/dsh-session-import/releases/latest/download/dsh-session-import-1.0.1.tgz
```

Or install from a local copy of that same archive, which is what `INSTALL.md` covers for an offline hand-off.

The bundle needs a DSH that provides the plugin Web carrier, the session persistence service, the workspace registry, and the connection service that carries the browser-trust fence. Requires DSH `>=0.2.0-rc.2 <0.3.0-0`.

## Configuration

Defaults ship in `cordis.patch.yml` and are declared in the bundle's `Config` schema, so the settings form shows them and a mistyped value fails the load instead of being ignored. Override any field in the profile's plugin row; a row that sets one field restates all of them, because a row's config replaces the bundle's rather than merging with it.

| Key | Default | Meaning |
| --- | --- | --- |
| `codexHome` | `''` | Codex directory; empty means `$CODEX_HOME`, then `~/.codex` |
| `claudeHome` | `''` | Claude directory; empty means `$CLAUDE_CONFIG_DIR`, then `~/.claude` |
| `workbuddyHome` | `''` | WorkBuddy directory; empty means `$WORKBUDDY_HOME`, then `~/.workbuddy` |
| `toolOutputLimit` | `4000` | characters kept per tool output at L3; `0` keeps everything |
| `createWorkspace` | `true` | create the Workspace an imported session belongs to |
| `publishSessions` | `true` | resume an imported session so it appears without a restart |

## Endpoints

The browser half talks to the Host half below `/session-import`. All three endpoints are `POST` and are reachable only over the loopback interface.

Every request passes the Host's own browser-trust fence first — the same `ctx.connection.requestRejection` that guards `/api` — so a request whose `Host` names any domain other than this listener is refused even when a matching `Origin` accompanies it. That closes DNS rebinding, which `Origin`-only comparison cannot; it also refuses a bare `Origin:` and a request carrying no DSH session.

- `/ping` — the directory each source resolves to.
- `/scan` — the conversations found, with the requested scope applied.
- `/import` — write the selected conversations. A conversation is identified by `{source, id}` and must be one the Host scanned itself, so no path ever crosses the wire.


## Layout

```
lib/index.js    Host entry: endpoints, workspace grouping, publication
lib/sources.js  one adapter per client: directory, scan, transcript → items
lib/build.js    items → DSH session events, per granularity
lib/client.js   sidebar icon and the import page
```

## License

MIT.
