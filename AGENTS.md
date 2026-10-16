# AGENTS.md

OpenCode server plugin. It lets sessions of the same project discover and message each other.

## Layout

- `src/index.ts` — plugin definition: wires the registry, the event watcher, the tools, the hook and the skill.
- `src/service.ts` — reads the OpenCode service registration file to build the HTTP endpoint + auth headers.
- `src/api.ts` — minimal `GET` client over that endpoint.
- `src/registry.ts` — peer discovery (`/api/session`, `/api/session/active`) with a TTL cache.
- `src/tools.ts` — `peers_list` and `peers_send`, target resolution, permission assert, rate limit.
- `src/inject.ts` — `context` hook that appends the peer block to the system prompt.
- `src/envelope.ts` — the message header a peer receives, and its metadata contract.
- `src/guards.ts` — hop counter and rate limit.
- `src/options.ts` — option parsing with defaults.
- `src/skill.ts` — the `session-bus` skill registered by the plugin.

## Rules

- No runtime dependency: `@opencode/plugin` is provided by the host. Keep it in `devDependencies` only.
- The plugin must never break a session: every external call is wrapped, and a missing service registration
  disables the plugin for that location with a log line instead of throwing.
- Tool descriptions and injected text are English: they are model instructions, not user-facing copy.
- Do not keep dead code or unused options for compatibility. Remove what is not used.

## Checks

```sh
bun install
bun run typecheck
```

There is no test suite: verify against a live service.

1. Plugins load with the location; `location.reload` is not enough. Evict then re-open the location:
   `opencode api delete "/api/debug/location?location%5Bdirectory%5D=<dir>"` then
   `opencode api get "/api/location?location%5Bdirectory%5D=<dir>"`. `opencode service restart` covers everything.
2. `opencode api get /api/plugin` (against that location) → `session-bus` must be `active`.
3. With `debug: true`, `~/.local/state/opencode/session-bus.log` shows load, tool list, injections and deliveries.
4. Two sessions in the same project: `peers_list` must see the other one (also across worktrees of the
   project), and `peers_send` must land as a `synthetic` message in the target session.
5. Test driver used during development: `~/tmp/oc/bus-test*.py` (creates sessions, prompts them, dumps transcripts).
