/** @jsxImportSource @opentui/solid */
import { For, Show, createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import {
  type Peer,
  type SessionLike,
  type SessionMessageLike,
  activityLine,
  countPeerMessages,
  lastToolUse,
  selectPeers,
} from "./peers"

const REFRESH_MS = 15_000
const DEBOUNCE_MS = 1_500
const IDLE_MS = 15 * 60_000
const MAX_PEERS = 8
const ACTIVITY_TTL_MS = 30_000
/** A peer message stops showing as unread after this long, even without a click. */
const UNREAD_WINDOW_MS = 15 * 60_000
const STORE_KEY = "session-bus"
const SEEN_KEY = "session-bus.seen"

interface Row {
  readonly peer: Peer
  readonly activity?: string
  readonly unread: boolean
}

/**
 * TUI half of the session-bus plugin: a collapsible "Linked sessions" block in
 * the right sidebar. The title toggles it, a line opens that session's tab, and
 * a click marks the peer's messages as read.
 */
export default Plugin.define({
  id: "session-bus.tui",

  setup(context) {
    const [rows, setRows] = createSignal<readonly Row[]>([])
    const [hovered, setHovered] = createSignal<string | undefined>()
    const [ui, updateUi] = context.storage.store(STORE_KEY, { initial: { expanded: true } })
    const [seen, updateSeen] = context.storage.memory(SEEN_KEY, { initial: {} as Record<string, number> })

    const directory = context.location?.directory
    const cleanups: Array<() => void> = []
    const activityCache = new Map<string, { at: number; value?: string }>()
    let selfSessionID: string | undefined

    const markSeen = (peerID: string) => updateSeen((draft) => void (draft[peerID] = Date.now()))

    const toggle = () => void updateUi((draft) => void (draft.expanded = !draft.expanded))

    const open = (peerID: string) => {
      markSeen(peerID)
      if (!context.ui.tabs.focus(peerID)) context.ui.router.navigate({ type: "session", sessionID: peerID })
    }

    /** What the peer is doing now, or did last: cached, the sidebar must stay cheap. */
    const activityOf = async (peer: Peer): Promise<string | undefined> => {
      const cached = activityCache.get(peer.id)
      if (cached && Date.now() - cached.at < ACTIVITY_TTL_MS) return cached.value
      let value = cached?.value
      try {
        const response = await context.client.message.list({ sessionID: peer.id, limit: 20 })
        value = activityLine(lastToolUse(response.data as readonly SessionMessageLike[]), peer.running)
      } catch {
        // keep the previous value
      }
      activityCache.set(peer.id, { at: Date.now(), value })
      return value
    }

    /** Peer wrote to this session since the last click, inside the unread window. */
    const unreadOf = async (peerID: string): Promise<boolean> => {
      if (!selfSessionID) return false
      try {
        const response = await context.client.message.list({
          sessionID: selfSessionID,
          limit: 30,
          type: "synthetic",
        })
        const since = Math.max(seen[peerID] ?? 0, Date.now() - UNREAD_WINDOW_MS)
        return countPeerMessages(response.data as readonly SessionMessageLike[], peerID, since) > 0
      } catch {
        return false
      }
    }

    const refresh = async () => {
      if (!directory) return
      if (!selfSessionID) {
        const current = context.ui.router.current()
        if (current.type === "session") selfSessionID = current.sessionID
      }
      try {
        const [listed, active] = await Promise.all([
          context.client.session.list({ directory, limit: 100 }),
          context.client.session.active(),
        ])
        const running = new Set(
          Object.entries((active as { data?: Record<string, { type?: string }> }).data ?? {})
            .filter(([, value]) => value?.type === "running")
            .map(([id]) => id),
        )
        const peers = selectPeers(((listed as { data?: readonly SessionLike[] }).data ?? []) as readonly SessionLike[], {
          scope: "directory",
          directory,
          includeIdle: false,
          idleWindowMs: IDLE_MS,
          maxPeers: MAX_PEERS,
          running,
        })
        const next: Row[] = []
        for (const peer of peers) {
          const [activity, unread] = await Promise.all([activityOf(peer), unreadOf(peer.id)])
          next.push({ peer, activity, unread })
        }
        setRows(next)
      } catch {
        // Keep the last known list: the sidebar must never break the TUI.
      }
    }

    let debounce: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (debounce) return
      debounce = setTimeout(() => {
        debounce = undefined
        void refresh()
      }, DEBOUNCE_MS)
    }

    if (directory) {
      void refresh()
      const interval = setInterval(() => void refresh(), REFRESH_MS)
      cleanups.push(() => clearInterval(interval))
      const unsubscribe = context.data.listen(({ details }) => {
        const type = typeof details?.type === "string" ? details.type : ""
        if (type.startsWith("session.")) schedule()
      })
      cleanups.push(unsubscribe)
      cleanups.push(() => debounce && clearTimeout(debounce))
    }

    const titleBudget = () => Math.max(14, Math.min(32, Math.floor(context.renderer.terminalWidth * 0.26)))

    try {
      context.ui.slot({
        append: "sidebar.content",
        render: ({ sessionID }) => {
          selfSessionID = sessionID
          const others = () => rows().filter((row) => row.peer.id !== sessionID)
          const label = () =>
            `${others().length === 1 ? "Linked session" : "Linked sessions"} (${others().length})`
          return (
            <Show when={others().length > 0}>
              <box flexDirection="column">
                <text fg={context.theme.text.muted} onMouseDown={() => toggle()}>{`${
                  ui.expanded ? "▾" : "▸"
                } ${label()}`}</text>
                <Show when={ui.expanded}>
                  <For each={others()}>
                    {(row) => (
                      <box
                        flexDirection="column"
                        onMouseDown={(event?: { stopPropagation?: () => void }) => {
                          event?.stopPropagation?.()
                          open(row.peer.id)
                        }}
                        onMouseOver={() => setHovered(row.peer.id)}
                        onMouseOut={() => setHovered((current) => (current === row.peer.id ? undefined : current))}
                      >
                        <text
                          fg={row.peer.running ? context.theme.text.base : context.theme.text.muted}
                          bg={hovered() === row.peer.id ? context.theme.background.raised.base : undefined}
                        >
                          {`${row.peer.running ? "●" : "○"} ${row.peer.handle}  ${short(
                            row.peer.title,
                            titleBudget(),
                          )}${row.unread ? " •" : ""}`}
                        </text>
                        <Show when={row.activity}>
                          <text fg={context.theme.text.muted}>{`   ${short(row.activity ?? "", titleBudget())}`}</text>
                        </Show>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
          )
        },
      })
    } catch {
      // Older TUI without the sidebar slot: the server tools still work.
    }

    try {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "session-bus.peers",
            title: "Linked sessions",
            description: "Other OpenCode sessions working in the same folder",
            group: "Session bus",
            palette: true,
            slash: { name: "peers", aliases: ["sessions"] },
            run: async () => {
              const current = context.ui.router.current()
              const self = current.type === "session" ? current.sessionID : undefined
              const list = rows().filter((row) => row.peer.id !== self)
              if (list.length === 0) {
                await context.ui.dialog.alert({
                  title: "Session bus",
                  message: "No other OpenCode session is working in this folder.",
                })
                return
              }
              const chosen = await context.ui.dialog.select({
                title: "Linked sessions",
                options: list.map((row) => ({
                  title: `${row.peer.handle} ${row.peer.title}`,
                  value: row.peer.id,
                  description: row.activity ? `${row.peer.directory} — ${row.activity}` : row.peer.directory,
                  footer: row.peer.running ? "working now" : "idle",
                })),
              })
              if (chosen) open(chosen)
            },
          },
        ],
      }))
    } catch {
      // Keymap registration is best effort too.
    }

    return () => {
      for (const cleanup of cleanups) {
        try {
          cleanup()
        } catch {
          // ignore
        }
      }
    }
  },
})

function short(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, Math.max(1, budget - 1))}…`
}
