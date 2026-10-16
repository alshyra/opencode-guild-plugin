/** @jsxImportSource @opentui/solid */
import { For, Show, createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { type Peer, type SessionLike, peerCountLabel, selectPeers } from "./peers"

const REFRESH_MS = 15_000
const DEBOUNCE_MS = 1_500
const IDLE_MS = 15 * 60_000
const MAX_PEERS = 20

/**
 * TUI counterpart of the session-bus server plugin: a counter of the other
 * sessions working in the same folder, in the right-hand sidebar, plus a
 * `/peers` command to jump to one of them.
 */
export default Plugin.define({
  id: "session-bus.tui",

  setup(context) {
    const [peers, setPeers] = createSignal<readonly Peer[]>([])
    const directory = context.location?.directory
    const cleanups: Array<() => void> = []

    const refresh = async () => {
      if (!directory) return
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
        setPeers(
          selectPeers(((listed as { data?: readonly SessionLike[] }).data ?? []) as readonly SessionLike[], {
            scope: "directory",
            directory,
            includeIdle: false,
            idleWindowMs: IDLE_MS,
            maxPeers: MAX_PEERS,
            running,
          }),
        )
      } catch {
        // The sidebar must never break the TUI: keep the last known list.
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

    try {
      context.ui.slot({
        append: "sidebar.content",
        render: ({ sessionID }) => {
          const others = () => peers().filter((peer) => peer.id !== sessionID)
          return (
            <Show when={others().length > 0}>
              <box flexDirection="column">
                <text>{`-- ${peerCountLabel(others().length)} --`}</text>
                <For each={others()}>
                  {(peer) => (
                    <text>{`${peer.running ? "*" : "-"} ${peer.handle} ${short(peer.title)}`}</text>
                  )}
                </For>
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
              const list = peers().filter((peer) => peer.id !== self)
              if (list.length === 0) {
                await context.ui.dialog.alert({
                  title: "Session bus",
                  message: "No other OpenCode session is working in this folder.",
                })
                return
              }
              const chosen = await context.ui.dialog.select({
                title: "Linked sessions",
                options: list.map((peer) => ({
                  title: `${peer.handle} ${peer.title}`,
                  value: peer.id,
                  description: peer.directory,
                  footer: peer.running ? "working now" : "idle",
                })),
              })
              if (!chosen) return
              if (!context.ui.tabs.focus(chosen)) context.ui.router.navigate({ type: "session", sessionID: chosen })
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

function short(title: string): string {
  return title.length <= 24 ? title : `${title.slice(0, 23)}…`
}
