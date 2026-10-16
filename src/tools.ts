import type { Ctx } from "./types"
import type { Guards } from "./guards"
import type { SessionBusOptions } from "./options"
import type { Api } from "./api"
import type { Registry } from "./registry"
import type { MemoryStore } from "./memory"
import { type Peer, describePeer } from "./peers"
import { BUS_ID, renderPeerMessage, stripPeerEnvelope, type PeerMessageKind, type PeerMessageMeta } from "./envelope"
import { describeActivity } from "./activity"
import { isDelegationRequest, type Delegations } from "./delegations"
import { describeEntry, isStale, normalizeTags, selectEntries, type MemoryDigest, type MemoryEntry } from "./memory"
import { compressMemory, type CompressReport } from "./compress"
import { humanAge, log, truncate, warn } from "./log"

export interface Deps {
  readonly ctx: Ctx
  readonly registry: Registry
  readonly guards: Guards
  readonly options: SessionBusOptions
  readonly api: Api
  readonly memory: MemoryStore
  readonly delegations: Delegations
}

interface Caller {
  readonly sessionID: string
  readonly agent?: string
  readonly messageID: string
  readonly id: string
  readonly signal?: AbortSignal
}

interface ListInput {
  readonly include_idle?: boolean
}

interface SendInput {
  readonly target?: string
  readonly message?: string
  readonly expect_reply?: boolean
  readonly reply_to?: string
}

interface AskInput {
  readonly target?: string
  readonly question?: string
  readonly timeout_seconds?: number
}

interface ActivityInput {
  readonly target?: string
  readonly messages?: number
}

interface DelegateInput {
  readonly target?: string
  readonly task?: string
  readonly context?: string
}

interface MemoryWriteInput {
  readonly text?: string
  readonly tags?: readonly string[]
  readonly key?: string
  readonly pinned?: boolean
}

interface MemoryReadInput {
  readonly query?: string
  readonly tags?: readonly string[]
  readonly limit?: number
}

interface MemoryForgetInput {
  readonly target?: string
}

interface MemoryRewriteInput {
  readonly remove?: readonly string[]
  readonly add?: readonly { readonly text?: string; readonly tags?: readonly string[]; readonly key?: string }[]
  readonly dry_run?: boolean
}

interface MemoryCompressInput {
  readonly dry_run?: boolean
  readonly instructions?: string
}

const TARGET_PROPERTY = {
  type: "string",
  description:
    "The peer session: a session id (ses_...), a unique session id prefix, or the number from the peers_list of " +
    "this same turn. The numbers are positional and can point at another session in a later turn: prefer the id " +
    "once you have it.",
} as const

export async function registerTools(ctx: Ctx, deps: Deps) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "peers_list",
      description:
        "List the other OpenCode sessions working in the same folder (same project and same checkout). " +
        "Use it when the user asks what another session is doing, and before peers_send, peers_ask or peers_delegate.",
      input: {
        type: "object",
        properties: {
          include_idle: {
            type: "boolean",
            description: "Also list sessions that have been idle for a long time. Defaults to false.",
          },
        },
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as ListInput
        const peers = await deps.registry.peers({
          self: context.sessionID,
          scope: deps.options.scope,
          includeIdle: input.include_idle === true || deps.options.includeIdle,
        })
        if (peers.length === 0) {
          return { content: `No other session is working in ${deps.options.scope === "directory" ? "this folder" : "this project"}.`, metadata: { peers: [] } }
        }
        const lines = peers.map((peer, index) => `${index + 1}. ${describePeer(peer)}`)
        return {
          content: [
            `${peers.length} other session(s) here:`,
            ...lines,
            `Message one with peers_send(target="1", message="..."), ask one with peers_ask, or delegate work with peers_delegate.`,
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
        "Send a plain-text note to another session of the same folder, listed by peers_list. Its agent reads it as an incoming " +
        "message. Use it to inform a peer of something that affects its work (a renamed field, a moved file, a decision). Send " +
        "text you write yourself: never conversation history, file contents or diffs.",
      input: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          message: {
            type: "string",
            description: "The note. Keep it short, factual and self-contained: the peer only sees this text.",
          },
          expect_reply: {
            type: "boolean",
            description: "Ask the peer to answer you. Defaults to false.",
          },
          reply_to: {
            type: "string",
            description:
              "Optional: the delegation id (dlg_...) this message answers, echoed from the request. Send it so the peer can match your report to the task.",
          },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as SendInput
        const body = String(input.message ?? "").trim()
        const invalid = validateBody(deps, body)
        if (invalid) return { content: invalid }
        const peer = await resolveInputPeer(deps, context, input.target)
        if (typeof peer === "string") return { content: peer }
        const replyTo = typeof input.reply_to === "string" && input.reply_to.trim() ? input.reply_to.trim() : undefined
        try {
          const result = await deliver(deps, {
            caller: callerOf(context),
            peer,
            body,
            kind: "note",
            expectReply: input.expect_reply === true,
            ...(replyTo ? { replyTo } : {}),
          })
          return {
            content: `Delivered to ${peer.handle} "${peer.title}" (${deliveryLabel(peer, result.delivery)}).`,
            metadata: { to: peer.id, delivery: result.delivery, hop: result.hop },
          }
        } catch (cause) {
          return { content: errorText(cause) }
        }
      },
    })

    editor.add({
      name: "peers_ask",
      description:
        "Ask another session of the same folder a question and wait for its answer. Use it when you need to know something that " +
        "only that session knows: what it is doing, why the workspace is in a given state, whether it already changed a file. " +
        "Returns the peer's answer, or a note that it has not answered yet.",
      input: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          question: {
            type: "string",
            description: "A short, direct question. The peer sees only this text.",
          },
          timeout_seconds: {
            type: "number",
            description: `How long to wait for the answer, 10 to 600. Defaults to the configured ${deps.options.askTimeoutSeconds}s. A peer needs a full turn to answer, so do not lower it without reason.`,
          },
        },
        required: ["target", "question"],
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as AskInput
        const body = String(input.question ?? "").trim()
        const invalid = validateBody(deps, body)
        if (invalid) return { content: invalid }
        const peer = await resolveInputPeer(deps, context, input.target)
        if (typeof peer === "string") return { content: peer }
        const timeoutSeconds = clamp(input.timeout_seconds, 10, 600, deps.options.askTimeoutSeconds)
        const since = Date.now() - 1_000
        try {
          await deliver(deps, {
            caller: callerOf(context),
            peer,
            body,
            kind: "question",
            expectReply: true,
          })
        } catch (cause) {
          return { content: errorText(cause) }
        }
        const answer = await waitForReply(deps, {
          self: context.sessionID,
          peerID: peer.id,
          since,
          timeoutMs: timeoutSeconds * 1000,
          ...(context.signal ? { signal: context.signal } : {}),
        })
        if (answer) {
          return {
            content: `Answer from ${peer.handle} "${peer.title}":\n${answer}`,
            metadata: { from: peer.id, answered: true, waitedSeconds: Math.round((Date.now() - since) / 1000) },
          }
        }
        const blocked = await peerPermissionHint(deps, peer)
        return {
          content:
            `Question sent to ${peer.handle} "${peer.title}", still unanswered after ${Math.round((Date.now() - since) / 1000)}s.` +
            blocked +
            ` Do not wait any longer: continue with what you have, and tell the user the peer has not answered. ` +
            `If it answers later, its message will arrive as a normal peer message.`,
          metadata: { from: peer.id, answered: false, blocked },
        }
      },
    })

    editor.add({
      name: "peers_activity",
      description:
        "Inspect what another session of the same folder is doing: its recent conversation, the tools it ran, the files its last " +
        "turn changed, and the uncommitted state of its directory. Use it to answer 'what are you doing?', 'why is the workspace " +
        "in this state?' or to check whether a peer already touched a file, before asking it directly with peers_ask.",
      input: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          messages: {
            type: "number",
            description: `How many recent conversation and tool entries to include, 1 to 40. Defaults to ${deps.options.activityLines}.`,
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as ActivityInput
        const peer = await resolveInputPeer(deps, context, input.target)
        if (typeof peer === "string") return { content: peer }
        const lines = clamp(input.messages, 1, 40, deps.options.activityLines)
        try {
          const report = await describeActivity(deps.api, peer, { messages: lines, files: lines })
          return { content: report, metadata: { target: peer.id } }
        } catch (cause) {
          return { content: `Could not read ${peer.handle}'s activity: ${errorText(cause)}` }
        }
      },
    })

    editor.add({
      name: "peers_delegate",
      description:
        "Delegate a task to another session of the same folder and keep working: this is the asynchronous counterpart of peers_ask. " +
        "The task is delivered now, this call returns immediately, the peer is told to treat it as a task from your user, and its " +
        "report wakes you when it comes back. Use it to hand off work ('prends ca', 'passe le relais') and use peers_ask only when " +
        "you cannot continue without the answer right now.",
      input: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          task: {
            type: "string",
            description: "What the peer must take on, phrased as an instruction. Be specific and self-contained.",
          },
          context: {
            type: "string",
            description: "Optional: current state, files, decisions or blockers the peer needs before starting.",
          },
        },
        required: ["target", "task"],
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as DelegateInput
        const task = String(input.task ?? "").trim()
        const invalid = validateBody(deps, task)
        if (invalid) return { content: invalid }
        const peer = await resolveInputPeer(deps, context, input.target)
        if (typeof peer === "string") return { content: peer }
        const contextNote = String(input.context ?? "").trim()
        const body = contextNote ? `${task}\n\nContext from my side:\n${contextNote}` : task
        // Registered before delivery: a very fast report must find the
        // delegation already there, not race it.
        const delegation = deps.delegations.register({
          requester: context.sessionID,
          peer: peer.id,
          task: body,
        })
        try {
          const result = await deliver(deps, {
            caller: callerOf(context),
            peer,
            body,
            kind: "delegate",
            expectReply: true,
            delegation: delegation.id,
          })
          return {
            content:
              `Delegated to ${peer.handle} "${peer.title}" (${delegation.id}, ${deliveryLabel(peer, result.delivery)}). ` +
              `Continue with your own work: you will be woken when it reports back. ` +
              `Check what is still outstanding with peers_delegations.`,
            metadata: { to: peer.id, delegation: delegation.id, delivery: result.delivery, hop: result.hop },
          }
        } catch (cause) {
          deps.delegations.forget(delegation.id)
          return { content: errorText(cause) }
        }
      },
    })

    editor.add({
      name: "peers_delegations",
      description:
        "List the tasks you delegated to peers with peers_delegate and have not been answered on yet. Use it to see what you are still " +
        "waiting for before reporting to the user, or when a report arrives and you want to know what it answers.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_raw, context) => {
        const pending = deps.delegations.pending(context.sessionID)
        if (pending.length === 0) {
          return { content: "No outstanding delegation: every task you handed to a peer has been answered." }
        }
        const now = Date.now()
        const lines = pending.map((delegation) => {
          const info = deps.registry.info(delegation.peer)
          const handle = delegation.peer.slice(0, 14)
          const who = info?.title ? `${handle} "${truncate(info.title, 50)}"` : handle
          return `- ${delegation.id} -> ${who}, sent ${humanAge(delegation.at, now)}: ${truncate(delegation.task, 140)}`
        })
        return {
          content: [
            `Waiting on ${pending.length} delegation(s):`,
            ...lines,
            "Their replies wake you when they arrive; do not block on them with peers_ask.",
          ].join("\n"),
          metadata: { pending: pending.map((delegation) => delegation.id) },
        }
      },
    })

    if (!deps.options.memory) return

    editor.add({
      name: "memory_write",
      description:
        "Record a durable fact, decision or convention in the long-term memory of this folder. Every session working here " +
        "reads it, now and later, so use it for what another session would otherwise have to rediscover: a contract you " +
        "changed, a command or path that works, a choice the user made, a dead end. Write text you author yourself: never " +
        "secrets, credentials, file contents or diffs.",
      input: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The fact, short and self-contained: one idea per entry, the way you would tell a colleague.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: 'Optional labels to find it again, for example ["config", "k8s"].',
          },
          key: {
            type: "string",
            description:
              "Optional stable handle for a fact that evolves (e.g. \"current-release\"): writing again with the same " +
              "key replaces the previous entry instead of adding one.",
          },
          pinned: {
            type: "boolean",
            description:
              "Keep this entry first in the injected block and protect it from the size cap. Reserve it for standing rules.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MemoryWriteInput
        const text = String(input.text ?? "").trim()
        if (!text) return { content: "Nothing was recorded: the text is empty." }
        if (text.length > deps.options.memoryMaxChars) {
          return {
            content: `Too long (${text.length} characters, limit ${deps.options.memoryMaxChars}). Keep one fact per entry and split the rest.`,
          }
        }
        const tags = normalizeTags(input.tags)
        const key = typeof input.key === "string" && input.key.trim() ? input.key.trim() : undefined
        const pinned = input.pinned === true
        try {
          // Elevation: pinning pushes a line into every session's prompt, so it
          // is gated. A plain note is not.
          if (pinned) {
            await deps.ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: "memory.promote",
              resources: [key ?? truncate(text, 60)],
              save: [key ?? truncate(text, 60)],
              source: { type: "tool", messageID: context.messageID, id: context.id },
              metadata: { text: truncate(text, 120), pinned: true },
            })
          }
          const sender = await senderInfo(deps, context.sessionID)
          const result = deps.memory.write({
            session: sender.id,
            title: sender.title,
            ...(context.agent ? { agent: context.agent } : {}),
            text,
            tags,
            ...(key ? { key } : {}),
            pinned,
          })
          const where = deps.ctx.location.directory
          if (result.duplicate) {
            const hits = result.entry.hits ?? 0
            const nudge =
              !result.entry.pinned && hits >= deps.options.memoryPromoteAfter
                ? ` This fact has now come back ${hits} times: if it is a standing rule, elevate it with memory_promote(target="${result.entry.id}").`
                : ""
            return {
              content: `Already in the folder memory of ${where} as ${result.entry.id} (×${hits}): "${truncate(result.entry.text, 120)}". Its weight grew; nothing was added.${nudge}`,
              metadata: { id: result.entry.id, duplicate: true, hits, total: result.total },
            }
          }
          const replaced = result.replaced ? `, replaced the previous entry for key "${result.entry.key ?? ""}"` : ""
          const dropped = result.dropped > 0 ? `, dropped ${result.dropped} oldest unpinned entry(ies)` : ""
          const weight = result.entry.hits ? ` (×${result.entry.hits})` : ""
          return {
            content: `Recorded in the folder memory of ${where} as ${result.entry.id}${weight} (${result.total} entries${replaced}${dropped}).`,
            metadata: { id: result.entry.id, duplicate: false, total: result.total },
          }
        } catch (cause) {
          return { content: errorText(cause) }
        }
      },
    })

    editor.add({
      name: "memory_promote",
      description:
        "Elevate one folder-memory entry to a standing rule (or demote it): a pinned entry comes first in the injected block, " +
        "survives the entry cap and is never touched by a compression. Use it when a fact keeps coming back, or when the user " +
        "decides something must always hold. Promoting asks the user first: it changes what every session of the folder reads. " +
        "Demoting needs no approval and archives the file.",
      input: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "The entry: its id (mem_...), its key, or an unambiguous fragment of its text.",
          },
          pin: {
            type: "boolean",
            description: "true (default) makes it a standing rule, false demotes it back to a normal note.",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as { target?: string; pin?: boolean }
        const target = String(input.target ?? "").trim()
        if (!target) return { content: "Nothing to promote: the target is empty." }
        const pin = input.pin !== false
        try {
          const matches = deps.memory.all().filter((entry) => entry.id === target || entry.key === target)
          const entry = matches.length === 1 ? matches[0] : undefined
          if (pin) {
            await deps.ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: "memory.promote",
              resources: [entry?.id ?? target],
              save: [entry?.id ?? target],
              source: { type: "tool", messageID: context.messageID, id: context.id },
              metadata: { target, text: truncate(entry?.text ?? "", 120) },
            })
          }
          const result = deps.memory.promote(target, pin)
          if ("error" in result) return { content: result.error }
          if (!result.changed) {
            return {
              content: `${result.entry.id} is already ${pin ? "a standing rule" : "a normal note"}: nothing changed.`,
            }
          }
          const archive = result.archive ? ` Previous file archived at ${result.archive}.` : ""
          return {
            content: `${pin ? "Promoted" : "Demoted"} ${result.entry.id}: ${pin ? "it now comes first in the injected block" : "it is a normal note again"}.${archive}`,
            metadata: { id: result.entry.id, pinned: result.entry.pinned },
          }
        } catch (cause) {
          return { content: errorText(cause) }
        }
      },
    })

    editor.add({
      name: "memory_read",
      description:
        "Read the long-term memory of this folder: durable facts, decisions and conventions recorded by the sessions that " +
        "worked here. Search it by text or tags before rediscovering something, or to find out what an earlier session " +
        "decided. The most recent entries are also injected in your context.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive text to look for in the entries." },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Only return entries carrying all these tags.",
          },
          limit: {
            type: "number",
            description: `How many entries to return, 1 to 100. Defaults to ${deps.options.activityLines * 2}.`,
          },
        },
        additionalProperties: false,
      },
      execute: async (raw) => {
        const input = (raw ?? {}) as MemoryReadInput
        const where = deps.ctx.location.directory
        const all = deps.memory.all()
        if (all.length === 0) {
          return { content: `The folder memory of ${where} is empty. Record what matters with memory_write as you work.` }
        }
        const tags = (Array.isArray(input.tags) ? input.tags : []).map((tag) => String(tag).trim()).filter(Boolean)
        const limit = clamp(input.limit, 1, 100, deps.options.activityLines * 2)
        const now = Date.now()
        const entries = selectEntries(all, input.query, tags, limit, {
          now,
          halfLifeDays: deps.options.memoryHalfLifeDays,
        })
        if (entries.length === 0) {
          return {
            content: `No entry matches in the ${all.length} entries of ${where}. Call memory_read without a query to see them all.`,
          }
        }
        const filter = [input.query ? `query "${input.query}"` : "", tags.length ? `tags ${tags.join(", ")}` : ""]
          .filter(Boolean)
          .join(", ")
        const stale = all.filter((entry) => isStale(entry, now, deps.options.memoryStaleDays)).length
        const staleHint =
          stale > 0
            ? [
                `${stale} stale ${stale === 1 ? "entry was" : "entries were"} never reinforced since ${deps.options.memoryStaleDays} days: memory_compress or memory_forget them, or reinforce them if they still matter.`,
              ]
            : []
        const compressHint =
          deps.options.memoryCompressAfter > 0 && all.length >= deps.options.memoryCompressAfter
            ? [
                `The memory is large (${all.length} entries): memory_compress can merge the non-pinned ones into fewer, denser entries. The pinned entries are never touched and the previous file is archived first.`,
              ]
            : []
        return {
          content: [
            `Folder memory of ${where}: ${entries.length} of ${all.length} entries${filter ? ` (${filter})` : ""}, pinned first then weight and recency.`,
            ...entries.map((entry) => `- ${describeEntry(entry, 400, now, deps.options.memoryStaleDays)}`),
            "Record more with memory_write, drop a wrong entry with memory_forget(target=<id>).",
            ...staleHint,
            ...compressHint,
          ].join("\n"),
          metadata: { total: all.length, returned: entries.length, stale, ids: entries.map((entry) => entry.id) },
        }
      },
    })

    editor.add({
      name: "memory_forget",
      description:
        "Drop an entry from the long-term memory of this folder: a fact that became false, a duplicate, a note recorded by " +
        "mistake. Give the id shown by memory_read, the key it was written with, or a fragment of its text — as long as it " +
        "matches a single entry. Only do it when the user asks, or when the entry is provably wrong.",
      input: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Entry id (mem_...), a unique id prefix, the key it was written with, or a fragment of its text.",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      execute: async (raw) => {
        const input = (raw ?? {}) as MemoryForgetInput
        const target = String(input.target ?? "").trim()
        if (!target) return { content: "Nothing was removed: no entry was given." }
        const result = deps.memory.forget(target)
        if ("error" in result) return { content: result.error }
        const removed = result.removed[0] as MemoryEntry
        log(`forgot memory entry ${removed.id} in ${deps.ctx.location.directory}`)
        return {
          content: `Removed ${removed.id} from the folder memory of ${deps.ctx.location.directory}: "${truncate(removed.text, 120)}". ${deps.memory.all().length} entries left.`,
          metadata: { id: removed.id, removed: result.removed.length },
        }
      },
    })

    editor.add({
      name: "memory_rewrite",
      description:
        "Replace several entries of the folder memory in one atomic write: drop the entries you name and add the consolidated " +
        "ones. Use it to merge duplicates you found with memory_read, or to apply a consolidation you wrote yourself. Pinned " +
        "entries are only dropped if you name them, and the previous file is archived before the write.",
      input: {
        type: "object",
        properties: {
          remove: {
            type: "array",
            items: { type: "string" },
            description: "Entries to drop: ids (mem_...), keys, or unambiguous fragments of their text.",
          },
          add: {
            type: "array",
            description: "Entries to add, usually the merged replacements of the removed ones.",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "The fact, short and self-contained." },
                tags: { type: "array", items: { type: "string" }, description: "Optional labels." },
                key: { type: "string", description: "Optional stable handle, as in memory_write." },
              },
              required: ["text"],
              additionalProperties: false,
            },
          },
          dry_run: { type: "boolean", description: "Report what would change without writing." },
        },
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MemoryRewriteInput
        const remove = (Array.isArray(input.remove) ? input.remove : [])
          .map((item) => String(item).trim())
          .filter(Boolean)
        const drafts = Array.isArray(input.add) ? input.add : []
        if (remove.length === 0 && drafts.length === 0) {
          return { content: "Nothing to do: give at least one entry to remove or to add." }
        }
        const digests: MemoryDigest[] = []
        for (const draft of drafts) {
          const text = String(draft?.text ?? "").trim()
          if (!text) return { content: "Nothing was written: one of the entries to add has an empty text." }
          if (text.length > deps.options.memoryMaxChars) {
            return {
              content: `Nothing was written: one of the entries is too long (${text.length} characters, limit ${deps.options.memoryMaxChars}).`,
            }
          }
          const tags = normalizeTags(draft?.tags)
          const key = typeof draft?.key === "string" && draft.key.trim() ? draft.key.trim() : undefined
          digests.push({ text, tags, ...(key ? { key } : {}) })
        }
        const sender = await senderInfo(deps, context.sessionID)
        const result = deps.memory.replace({
          remove,
          add: digests,
          session: sender.id,
          title: sender.title,
          ...(context.agent ? { agent: context.agent } : {}),
          ...(input.dry_run === true ? { dryRun: true } : {}),
        })
        if ("error" in result) return { content: result.error }
        const dry = input.dry_run === true ? " (dry run, nothing written)" : ""
        return {
          content: [
            `Folder memory of ${deps.ctx.location.directory}${dry}: ${result.removed.length} removed, ${result.added.length} added, ${result.total} entries in total.`,
            ...result.removed.map((entry) => `  - removed ${entry.id}: ${truncate(entry.text, 100)}`),
            ...result.added.map((entry) => `  + added ${entry.id}: ${truncate(entry.text, 100)}`),
            result.archive ? `Previous file archived at ${result.archive}.` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          metadata: { removed: result.removed.length, added: result.added.length, total: result.total },
        }
      },
    })

    editor.add({
      name: "memory_compress",
      description:
        "Consolidate the folder memory: a model merges the duplicate and near-duplicate entries into fewer, denser ones. It is " +
        "one auxiliary model call — nothing is added to this conversation and no session is created. Pinned entries are never " +
        "touched and the previous file is archived first. Use it when the memory has grown and reads like a log rather than a " +
        "reference; run it once with dry_run if you want to see the merge before applying it.",
      input: {
        type: "object",
        properties: {
          dry_run: { type: "boolean", description: "Report the before/after without writing anything." },
          instructions: {
            type: "string",
            description: 'Optional extra instruction for the merge, for example "keep the absolute paths".',
          },
        },
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MemoryCompressInput
        try {
          deps.guards.assertCompressAllowed(context.sessionID)
        } catch (cause) {
          return { content: errorText(cause) }
        }
        const sender = await senderInfo(deps, context.sessionID)
        const report = await compressMemory(deps, {
          caller: { sessionID: sender.id, title: sender.title, ...(context.agent ? { agent: context.agent } : {}) },
          dryRun: input.dry_run === true,
          ...(typeof input.instructions === "string" && input.instructions.trim()
            ? { note: input.instructions.trim() }
            : {}),
        })
        return {
          content: describeCompression(deps, report),
          metadata: {
            applied: report.applied,
            before: report.before,
            after: report.after,
            merged: report.removed.length,
            skipped: report.skipped,
          },
        }
      },
    })
  })
}

function describeCompression(deps: Deps, report: CompressReport): string {
  const where = deps.ctx.location.directory
  if (report.problem) {
    const problem = report.problem.replace(/\.$/, "")
    const entries = `${report.before} ${report.before === 1 ? "entry" : "entries"}`
    return `Nothing was written for ${where}: ${problem}. The memory still holds ${entries}.`
  }
  const head = report.applied
    ? `Compressed the folder memory of ${where}: ${report.before} -> ${report.after} entries (${report.pool} non-pinned entries merged into ${report.entries.length}).`
    : `Dry run for ${where}: ${report.before} -> ${report.after} entries (${report.pool} non-pinned entries sent). Nothing was written yet: call memory_compress again without dry_run to apply it.`
  return [
    head,
    ...report.entries.slice(0, 20).map((entry) => `  - ${truncate(entry.text, 160)}`),
    report.skipped > 0
      ? `  (${report.skipped} returned ${report.skipped === 1 ? "entry was" : "entries were"} unusable and skipped)`
      : "",
    report.lostKeys.length > 0
      ? `  (keys that no longer address any entry: ${report.lostKeys.join(", ")} — re-add them with memory_write(key=...) if they still matter)`
      : "",
    report.archive ? `Previous file archived at ${report.archive}.` : "",
    report.applied
      ? "Pinned entries were left untouched. The memory is injected in the next sessions of this folder."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

interface DeliverInput {
  readonly caller: Caller
  readonly peer: Peer
  readonly body: string
  readonly kind: PeerMessageKind
  readonly expectReply: boolean
  /** Set when this message *is* a delegation: the id the peer must quote back. */
  readonly delegation?: string
  /** Set when this message *answers* a delegation: the id it answers. */
  readonly replyTo?: string
}

async function deliver(deps: Deps, input: DeliverInput): Promise<{ delivery: string; hop: number }> {
  deps.guards.assertRate(input.caller.sessionID, deps.options)
  const hop = deps.guards.nextHop(input.caller.sessionID)
  if (hop > deps.options.maxHop) {
    throw new Error(
      "this exchange already went back and forth between sessions too many times; answer the user directly instead",
    )
  }
  if (!(await allowSend(deps, input.caller, input.peer))) {
    throw new Error("sending to other sessions is disabled by the session-bus configuration")
  }
  const sender = await senderInfo(deps, input.caller.sessionID)
  const meta: PeerMessageMeta = {
    bus: BUS_ID,
    v: 1,
    from: sender.id,
    fromTitle: sender.title,
    fromDirectory: sender.directory,
    kind: input.kind,
    hop,
    ts: Date.now(),
    ...(input.delegation ? { delegation: input.delegation } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  }
  const delivered = await deps.ctx.session.synthetic({
    sessionID: input.peer.id,
    text: renderPeerMessage(meta, input.body, input.expectReply),
    description: `Message from ${sender.title}`,
    metadata: { ...meta, expectReply: input.expectReply },
    delivery: deps.options.delivery,
    resume: true,
  })
  deps.guards.noteDelivery(input.peer.id, input.caller.sessionID, hop)
  // A report closes the delegation it answers: explicitly by `reply_to`, or —
  // as a fallback — any message from the asked peer that is not itself a
  // delegation request coming the other way. The same delivery resumes the
  // requester, so the wake-up and the bookkeeping happen together.
  const answered = input.replyTo
    ? deps.delegations.resolveById(input.replyTo)
    : isDelegationRequest(input.kind)
      ? undefined
      : deps.delegations.resolvePair(input.peer.id, input.caller.sessionID)
  if (answered) log(`delegation ${answered.id} answered by ${input.caller.sessionID}`)
  log(`delivered ${input.kind} ${sender.id} -> ${input.peer.id} (${delivered?.delivery ?? "unknown"}, hop ${hop})`)
  return { delivery: String(delivered?.delivery ?? "queued"), hop }
}

async function allowSend(deps: Deps, caller: Caller, peer: Peer): Promise<boolean> {
  if (deps.options.permission === "allow") return true
  if (deps.options.permission === "deny") {
    warn(`blocked message to ${peer.id}: permission=deny`)
    return false
  }
  await deps.ctx.permission.assert({
    sessionID: caller.sessionID,
    agent: caller.agent,
    action: "session.message",
    resources: [peer.id],
    save: [peer.id],
    source: { type: "tool", messageID: caller.messageID, id: caller.id },
    metadata: { title: peer.title, handle: peer.handle, directory: peer.directory },
  })
  return true
}

interface InboxLike {
  readonly type?: string
  readonly text?: string
  readonly metadata?: Record<string, unknown>
  readonly time?: { readonly created?: number }
}

interface InboxItemLike {
  readonly type?: string
  readonly time?: { readonly created?: number }
  readonly payload?: {
    readonly text?: string
    readonly metadata?: Record<string, unknown>
  }
}

async function waitForReply(
  deps: Deps,
  input: {
    readonly self: string
    readonly peerID: string
    readonly since: number
    readonly timeoutMs: number
    readonly signal?: AbortSignal
  },
): Promise<string | undefined> {
  const deadline = Date.now() + input.timeoutMs
  for (;;) {
    const answer = await readAnswer(deps, input)
    if (answer) return answer
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    try {
      await sleep(Math.min(1_500, remaining), input.signal)
    } catch {
      // The incoming answer interrupts the running turn, which aborts this
      // tool. Read one last time before giving up, otherwise the answer that
      // just arrived would be missed.
      return readAnswer(deps, input)
    }
  }
}

async function readAnswer(
  deps: Deps,
  input: { readonly self: string; readonly peerID: string; readonly since: number },
): Promise<string | undefined> {
  // A steered message stays in the inbox until the current step ends, so while
  // this tool is blocking the answer is visible there, not in the transcript.
  try {
    const inbox = await deps.api.get<readonly InboxItemLike[]>(`/api/session/${input.self}/inbox`)
    const pending = inbox.find(
      (item) =>
        item.type === "synthetic" &&
        item.payload?.metadata?.["from"] === input.peerID &&
        (item.time?.created ?? 0) >= input.since,
    )
    if (pending?.payload?.text) return stripPeerEnvelope(pending.payload.text)
  } catch (cause) {
    warn("could not read own inbox while waiting for an answer", cause)
  }

  let messages: readonly InboxLike[]
  try {
    messages = await deps.api.get<readonly InboxLike[]>(`/api/session/${input.self}/message`, { limit: 50 })
  } catch (cause) {
    warn("could not read own transcript while waiting for an answer", cause)
    return undefined
  }
  const answer = messages
    .filter((message) => message.type === "synthetic" && typeof message.text === "string")
    .filter((message) => message.metadata?.["from"] === input.peerID && (message.time?.created ?? 0) >= input.since)
    .sort((left, right) => (left.time?.created ?? 0) - (right.time?.created ?? 0))[0]
  return answer?.text ? stripPeerEnvelope(answer.text) : undefined
}

async function peerPermissionHint(deps: Deps, peer: Peer): Promise<string> {
  try {
    const pending = await deps.api.get<readonly { readonly action?: string }[]>(`/api/session/${peer.id}/permission`)
    if (!pending.some((request) => request.action === "session.message")) return ""
    return ` The peer is waiting for a permission approval for that message: someone must approve it in that session's window before it can answer.`
  } catch {
    return ""
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function resolveInputPeer(deps: Deps, context: Caller, target: unknown): Promise<Peer | string> {
  const peers = await deps.registry.peers({ self: context.sessionID, scope: deps.options.scope, includeIdle: true })
  const peer = resolvePeer(peers, String(target ?? ""))
  if (peer) return peer
  const available = peers.length ? peers.map((item) => describePeer(item)).join("\n- ") : "(none)"
  return `No single session matches target "${String(target ?? "")}". Sessions available to you:\n- ${available}\nCall peers_list and use one of its numbers.`
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

function callerOf(context: {
  sessionID: string
  agent?: string
  messageID: string
  id: string
  signal?: AbortSignal
}): Caller {
  return {
    sessionID: context.sessionID,
    agent: context.agent,
    messageID: context.messageID,
    id: context.id,
    ...(context.signal ? { signal: context.signal } : {}),
  }
}

function validateBody(deps: Deps, body: string): string | undefined {
  if (!body) return "Nothing was sent: the text is empty."
  if (body.length > deps.options.maxMessageChars) {
    return `The text is too long (${body.length} characters, limit ${deps.options.maxMessageChars}). Shorten it first.`
  }
  return undefined
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function deliveryLabel(peer: Peer, delivery: string): string {
  if (peer.running || delivery === "steer") return "injected into its current turn"
  return "its session was resumed to read it"
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
