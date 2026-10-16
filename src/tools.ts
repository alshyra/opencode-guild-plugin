import type { Ctx } from "./types"
import type { Guards } from "./guards"
import type { SessionBusOptions } from "./options"
import { Registry, describePeer, type Peer } from "./registry"
import { BUS_ID, renderPeerMessage, type PeerMessageMeta } from "./envelope"
import { log, warn } from "./log"

export interface Deps {
  readonly ctx: Ctx
  readonly registry: Registry
  readonly guards: Guards
  readonly options: SessionBusOptions
}

interface ListInput {
  readonly scope?: string
  readonly include_idle?: boolean
}

interface SendInput {
  readonly target?: string
  readonly message?: string
  readonly expect_reply?: boolean
}

export async function registerTools(ctx: Ctx, deps: Deps) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "peers_list",
      description:
        "List the other OpenCode sessions working in the same project (the same repository, including its worktrees). " +
        "Use it when the user asks which other sessions are running or what they are working on, and before peers_send.",
      input: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["project", "directory"],
            description: "project (default) lists every checkout of the project; directory only the current checkout.",
          },
          include_idle: {
            type: "boolean",
            description: "Also list sessions that have been idle for a long time. Defaults to false.",
          },
        },
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as ListInput
        const scope = input.scope === "directory" ? "directory" : deps.options.scope
        const peers = await deps.registry.peers({
          self: context.sessionID,
          scope,
          includeIdle: input.include_idle === true || deps.options.includeIdle,
        })
        if (peers.length === 0) {
          return { content: "No other session is currently working on this project.", metadata: { peers: [] } }
        }
        const lines = peers.map(
          (peer, index) => `${index + 1}. ${describePeer(peer)}${peer.directory ? ` [${peer.directory}]` : ""}`,
        )
        return {
          content: [
            `${peers.length} other session(s) on this project:`,
            ...lines,
            `Write to one with peers_send(target="1", message="..."), or target the session id.`,
          ].join("\n"),
          metadata: {
            peers: peers.map((peer, index) => ({
              index: index + 1,
              id: peer.id,
              handle: peer.handle,
              title: peer.title,
              agent: peer.agent,
              directory: peer.directory,
              running: peer.running,
              updated: peer.updated,
            })),
          },
        }
      },
    })

    editor.add({
      name: "peers_send",
      description:
        "Send a plain-text message to another OpenCode session listed by peers_list. That session's agent reads it as an " +
        "incoming message and can reply. Use it when the user asks you to tell or ask something to another session, or when " +
        "a change you made invalidates what another session is doing. Send text you write yourself: never conversation " +
        "history, file contents or diffs. Never relay a message you received from another session.",
      input: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "The session to write to: the number from peers_list, a session id (ses_...) or a unique session id prefix.",
          },
          message: {
            type: "string",
            description: "The message text. Keep it short, factual and self-contained: the peer sees only this text.",
          },
          expect_reply: {
            type: "boolean",
            description: "Ask the peer to answer you. Defaults to false; use true only when you need an answer.",
          },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as SendInput
        const message = String(input.message ?? "").trim()
        if (!message) return { content: "The message is empty: nothing was sent." }
        if (message.length > deps.options.maxMessageChars) {
          return {
            content: `The message is too long (${message.length} chars, limit ${deps.options.maxMessageChars}). Summarize it first.`,
          }
        }

        const peers = await deps.registry.peers({
          self: context.sessionID,
          scope: deps.options.scope,
          includeIdle: true,
        })
        const peer = resolvePeer(peers, String(input.target ?? ""))
        if (!peer) {
          const available = peers.length ? peers.map((item) => describePeer(item)).join("\n- ") : "(none)"
          return {
            content: `No single session matches target "${input.target}". Sessions you can write to:\n- ${available}\nCall peers_list and use one of its numbers.`,
          }
        }

        try {
          deps.guards.assertRate(context.sessionID, deps.options)
        } catch (cause) {
          return { content: cause instanceof Error ? cause.message : String(cause) }
        }

        const hop = deps.guards.nextHop(context.sessionID)
        if (hop > deps.options.maxHop) {
          return {
            content:
              "This conversation already went back and forth between sessions too many times. Answer the user directly instead of messaging another session.",
          }
        }

        if (!(await allowSend(deps, context, peer))) {
          return { content: `Sending to other sessions is disabled by the session-bus configuration.` }
        }

        const sender = await senderInfo(deps, context.sessionID)
        const meta: PeerMessageMeta = {
          bus: BUS_ID,
          v: 1,
          from: sender.id,
          fromTitle: sender.title,
          fromDirectory: sender.directory,
          hop,
          ts: Date.now(),
        }
        const text = renderPeerMessage(meta, message, input.expect_reply === true)

        const delivered = await deps.ctx.session.synthetic({
          sessionID: peer.id,
          text,
          description: `Message from ${sender.title}`,
          metadata: { ...meta },
          delivery: deps.options.delivery,
          resume: true,
        })

        deps.guards.noteDelivery(peer.id, context.sessionID, hop)
        log(`delivered message ${sender.id} -> ${peer.id} (${delivered?.delivery ?? "unknown"})`)

        return {
          content: `Message delivered to ${peer.handle} "${peer.title}". ${
            peer.running ? "It was injected into its current turn." : "Its session was resumed to read it."
          }`,
          metadata: { to: peer.id, handle: peer.handle, delivery: delivered?.delivery ?? null },
        }
      },
    })
  })
}

async function allowSend(deps: Deps, context: { sessionID: string; agent?: string; messageID: string; id: string }, peer: Peer) {
  if (deps.options.permission === "allow") return true
  if (deps.options.permission === "deny") {
    warn(`blocked message to ${peer.id}: permission=deny`)
    return false
  }
  await deps.ctx.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    action: "session.message",
    resources: [peer.id],
    save: [peer.id],
    source: { type: "tool", messageID: context.messageID, id: context.id },
    metadata: { title: peer.title, handle: peer.handle, directory: peer.directory },
  })
  return true
}

async function senderInfo(
  deps: Deps,
  sessionID: string,
): Promise<{ id: string; title: string; directory: string }> {
  const cached = deps.registry.info(sessionID)
  if (cached?.title && cached.location?.directory) {
    return { id: sessionID, title: cached.title, directory: cached.location.directory }
  }
  try {
    const info = await deps.ctx.session.get({ sessionID })
    return {
      id: info.id,
      title: info.title?.trim() || "(untitled)",
      directory: info.location?.directory ?? deps.ctx.location.directory,
    }
  } catch (cause) {
    warn("could not read the sending session", cause)
    return { id: sessionID, title: "(untitled)", directory: deps.ctx.location.directory }
  }
}

function resolvePeer(peers: readonly Peer[], target: string): Peer | undefined {
  const wanted = target.trim()
  if (!wanted) return undefined
  if (/^\d+$/.test(wanted)) {
    const peer = peers[Number.parseInt(wanted, 10) - 1]
    if (peer) return peer
  }
  const exact = peers.find((peer) => peer.id === wanted)
  if (exact) return exact
  const lowered = wanted.toLowerCase()
  const byPrefix = peers.filter((peer) => peer.id.startsWith(lowered) || peer.handle === lowered)
  if (byPrefix.length === 1) return byPrefix[0]
  const byTitle = peers.filter((peer) => peer.title.toLowerCase().includes(lowered))
  if (byTitle.length === 1) return byTitle[0]
  return undefined
}
