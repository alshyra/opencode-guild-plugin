# AGENTS.md

OpenCode plugin, in two halves:

- `index.ts` → `src/index.ts`: the **server** plugin. Sessions of the same folder discover each other, list
  peers, send notes, ask questions, hand work over, inspect a peer's activity and share a long-term memory of
  that folder.
- `tui.tsx` → `src/tui.tsx`: the **CLI/TUI** plugin. Counter of linked sessions in the right sidebar, plus
  the `/peers` command.

Both entry files must stay at the repository root: the loader resolves a plugin directory to `index.ts` and
`tui.tsx` there, ignoring `package.json#exports`.

## Layout

- `src/index.ts` — plugin definition: wires the registry, the event watcher, the tools, the hook and the skill.
- `src/service.ts` — reads the OpenCode service registration file to build the HTTP endpoint + auth headers.
- `src/api.ts` — minimal `GET` client over that endpoint.
- `src/peers.ts` — pure peer types, selection and formatting, shared by the server and the TUI half.
- `src/registry.ts` — session discovery (`/api/session`, `/api/session/active`) with a short TTL cache.
- `src/tools.ts` — the ten tools: target resolution, permission assert, rate limit, hop counter, ask loop.
- `src/memory.ts` — the folder's long-term memory: file layout, JSONL parsing, atomic replace, archives, cap.
- `src/compress.ts` — the consolidation: prompt, tolerant JSON reader, `ctx.generate.text` call and report.
- `src/activity.ts` — the `peers_activity` report (transcript, tools, session diff, working copy).
- `src/inject.ts` — `context` hook that appends the peer block and the memory block to the system prompt.
- `src/envelope.ts` — the message a peer receives (header, kind, guidance) and its metadata contract.
- `src/guards.ts` — hop counter and rate limit.
- `src/options.ts` — option parsing with defaults.
- `src/skill.ts` — the `session-bus` skill registered by the plugin.
- `src/tui.tsx` — sidebar counter + `/peers` command.

## Rules

- No runtime dependency: `@opencode/plugin` is provided by the host. Keep it, OpenTUI and solid-js in
  `devDependencies` only.
- The plugin must never break a session or the TUI: every external call is wrapped, and a missing service
  registration disables the plugin for that location with a log line instead of throwing.
- Tool descriptions and injected text are English: they are model instructions, not user-facing copy.
- Do not keep dead code or unused options for compatibility. Remove what is not used.

## Behaviour worth remembering

- A message delivered to a running session is a steer: it waits in that session's **inbox** until the current
  step ends. `peers_ask` must therefore read `/api/session/{self}/inbox` while it blocks, not only the
  transcript (the transcript only sees it at the next step boundary). `peers_ask` returning also aborts the
  tool through `context.signal`, so the loop reads once more before giving up.
- Peer discovery is project-scoped at the API level and folder-filtered in `selectPeers`; `scope: "project"`
  widens it to every checkout of the project.
- OpenCode's default permission policy allows everything, so `permission: "ask"` only prompts when a
  `session.message` rule exists (see README).
- The sidebar block is click-driven (`onMouseDown`), not keyboard-driven: click toggles the title, a click on
  a line opens that session's tab. Expansion lives in `context.storage.store` (durable, shared), the unread
  markers in `context.storage.memory` (ephemeral) and are derived from the *current* session's synthetic
  messages — never from an event name, which is not documented. The sub-line is cached 30s per peer, and it
  must never imply work that is not happening: `running: …` only for a tool whose state is running/streaming,
  `last: …` only while the peer executes, nothing for an idle peer.
- The folder memory is one file per folder, `~/.opencode/session-bus/<sha1 of the folder>/memory.jsonl`, never
  inside the project: a folder is a checkout, so worktrees do not share it. Writes append; a rewrite (key
  replaced, cap reached, entry forgotten) always re-reads the file first and goes through `tmp + rename`, so a
  second service working in the same folder cannot lose an append. `memory_read` and the injected block read
  the same snapshot, cached for `cacheTtlSeconds`; `memory_write` and `memory_forget` always read from disk.
- Nothing in this plugin may break a session, memory included: every file operation is wrapped and a failure
  only warns once, then the folder behaves as if it had no memory.
- Compression never sees the pinned entries: the pool is filtered before the prompt, so an invariant holds by
  construction rather than by comparison. The model call is `ctx.generate.text` (auxiliary request: no session
  created, nothing added to the conversation), and the answer is only applied if it is valid JSON, usable and
  *smaller* than the input. Unusable entries are skipped and counted, never truncated.
- Every rewrite (key replaced, cap reached, `forget`, `replace`) archives the file in `history/` first, five
  generations deep; the archive name carries a random suffix because two rewrites can land in the same
  millisecond and would otherwise overwrite each other.

## Checks

```sh
bun install
bun run typecheck
```

There is no test suite: verify against a live service.

1. Plugins load with the location; `location.reload` is not enough. Evict then re-open the location:
   `opencode api delete "/api/debug/location?location%5Bdirectory%5D=<dir>"` then
   `opencode api get "/api/location?location%5Bdirectory%5D=<dir>"`. `opencode service restart` covers everything.
2. `opencode api get /api/plugin` → `session-bus` must be `active` with `features: { server: true, tui: true }`.
   The TUI half itself only loads at TUI startup.
3. With `debug: true`, `~/.local/state/opencode/session-bus.log` shows load, tool list, injections and deliveries.
4. Two sessions in the same folder: `peers_list` sees the other one, `peers_send` lands as a `synthetic`
   message in the target session, `peers_ask` returns the peer's answer, `peers_handoff` shows up as a
   handoff, `peers_activity` reports the peer's transcript and directory state.
5. Memory: `memory_write` in one session shows up in `memory_read` and in the injected block of the next
   session of the same folder; a `key` write replaces, `memory_forget` drops, and
   `~/.opencode/session-bus/<sha1 of the folder>/memory.jsonl` holds exactly the surviving entries.
6. Compression: run `memory_compress` in a folder seeded with near-duplicates and two pinned entries; the
   pinned ones must survive verbatim, `history/` must hold the byte-identical previous file, and a `dry_run`
   must leave the file untouched. The refusal branches (model failure, invalid JSON, no gain, nothing to
   merge) are covered by a stub context instead of a model call.
7. Test drivers used during development: `~/tmp/oc/bus-test*.py` (peers), `~/tmp/oc/mem-live-test.py`
   (memory), `~/tmp/oc/mem-compress-unit.ts` and `~/tmp/oc/mem-compress-refusals.ts` (pure functions and
   compression branches, run with `HOME=<sandbox> bun run`), `~/tmp/oc/mem-compress-live.py` (live
   compression, guarded by `--yes`).
