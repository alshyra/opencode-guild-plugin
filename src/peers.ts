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

export function peerCountLabel(count: number): string {
  return count === 1 ? "1 linked session" : `${count} linked sessions`
}
