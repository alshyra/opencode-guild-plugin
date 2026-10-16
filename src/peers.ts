import { humanAge, truncate } from "./log"

/** Minimal shape shared by the server API payloads and the TUI client types. */
export interface SessionLike {
  readonly id: string
  readonly parentID?: string
  readonly projectID?: string
  readonly agent?: string
  readonly title?: string
  readonly model?: { readonly providerID?: string; readonly id?: string }
  readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
  readonly location: { readonly directory: string }
}

/** A session as known from the API or from an event payload (possibly partial). */
export type IndexedSession = Partial<SessionLike> & { readonly id: string }

export interface Peer {
  readonly id: string
  readonly handle: string
  readonly title: string
  readonly agent?: string
  readonly model?: string
  readonly directory: string
  readonly projectID?: string
  readonly running: boolean
  readonly updated: number
}

export interface PeerSelection {
  /** Session to exclude, usually the caller. */
  readonly self?: string
  readonly scope: "project" | "directory"
  /** Directory of the requesting location, used by the directory scope. */
  readonly directory: string
  readonly includeIdle: boolean
  readonly idleWindowMs: number
  readonly maxPeers: number
  /** Sessions currently executing, as reported by the server. */
  readonly running: ReadonlySet<string>
  readonly now?: number
}

const SESSION_ID = /^ses_/

export function isSessionID(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value)
}

export function handleOf(id: string): string {
  return id.slice(0, 14)
}

export function toPeer(session: SessionLike, running: boolean): Peer {
  const model =
    session.model && (session.model.providerID || session.model.id)
      ? [session.model.providerID, session.model.id].filter(Boolean).join("/")
      : undefined
  return {
    id: session.id,
    handle: handleOf(session.id),
    title: session.title?.trim() || "(untitled)",
    agent: session.agent,
    model,
    directory: session.location?.directory ?? "",
    projectID: session.projectID,
    running,
    updated: session.time?.updated ?? 0,
  }
}

/** Root sessions of the same project (or checkout), excluding subagents and archived ones. */
export function selectPeers(sessions: readonly SessionLike[], selection: PeerSelection): readonly Peer[] {
  const now = selection.now ?? Date.now()
  return sessions
    .filter((session) => !session.parentID && !session.time?.archived)
    .filter((session) => session.id !== selection.self)
    .map((session) => toPeer(session, selection.running.has(session.id)))
    .filter((peer) => selection.scope === "project" || peer.directory === selection.directory)
    .filter((peer) => selection.includeIdle || peer.running || now - peer.updated < selection.idleWindowMs)
    .sort((left, right) => Number(right.running) - Number(left.running) || right.updated - left.updated)
    .slice(0, selection.maxPeers)
}

export function describePeer(peer: Peer, now = Date.now()): string {
  const status = peer.running ? "working now" : `idle, seen ${humanAge(peer.updated, now)}`
  const agent = peer.agent ? `, agent ${peer.agent}` : ""
  return `${peer.handle} "${truncate(peer.title, 70)}"${agent}, ${status}`
}

/** Structural shapes for the message payloads the client and the API return. */
export interface MessagePartLike {
  readonly type?: string
  readonly text?: string
  readonly name?: string
  readonly state?: { readonly status?: string; readonly input?: unknown }
  readonly content?: readonly MessagePartLike[]
}

export interface SessionMessageLike {
  readonly type?: string
  readonly time?: { readonly created?: number }
  readonly text?: string
  readonly metadata?: Record<string, unknown>
  readonly content?: readonly MessagePartLike[]
}

export interface ToolUse {
  readonly name: string
  readonly hint?: string
  readonly status: string
}

/** Last tool a session ran, with its live status, for the "what is it doing" one-liner. */
export function lastToolUse(messages: readonly SessionMessageLike[]): ToolUse | undefined {
  const ordered = [...messages].sort((left, right) => (left.time?.created ?? 0) - (right.time?.created ?? 0))
  let found: ToolUse | undefined
  for (const message of ordered) {
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type !== "tool" || !part.name) continue
      const hint = toolHint(part.state?.input)
      found = { name: part.name, status: part.state?.status ?? "unknown", ...(hint ? { hint } : {}) }
    }
  }
  return found
}

export function isToolRunning(status: string): boolean {
  return status === "running" || status === "streaming"
}

/** Under a peer: what it is doing right now, or what it did last, or nothing. */
export function activityLine(tool: ToolUse | undefined, peerRunning: boolean): string | undefined {
  if (!tool) return undefined
  const label = `${tool.name}${tool.hint ? ` ${tool.hint}` : ""}${tool.status === "error" ? " (failed)" : ""}`
  if (isToolRunning(tool.status)) return `running: ${label}`
  if (peerRunning) return `last: ${label}`
  return undefined
}

/** Peer messages still newer than the last acknowledgement, inside the unread window. */
export function countPeerMessages(
  messages: readonly SessionMessageLike[],
  peerID: string,
  since: number,
): number {
  return messages.filter(
    (message) =>
      message.type === "synthetic" &&
      message.metadata?.["from"] === peerID &&
      (message.time?.created ?? 0) > since,
  ).length
}

export function toolHint(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  for (const key of ["command", "filePath", "path", "file", "pattern", "description", "url", "target", "query"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return truncate(oneLine(value), 100)
  }
  return ""
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}
