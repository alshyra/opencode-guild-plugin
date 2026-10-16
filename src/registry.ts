import type { Api } from "./api"
import { humanAge, truncate } from "./log"

export interface SessionInfo {
  readonly id: string
  readonly parentID?: string
  readonly projectID?: string
  readonly agent?: string
  readonly title?: string
  readonly model?: { readonly providerID?: string; readonly id?: string }
  readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
  readonly location: { readonly directory: string }
}

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

/** A session as known from the API or from an event payload (possibly partial). */
export type IndexedSession = Partial<SessionInfo> & { readonly id: string }

export interface RegistryOptions {
  /** How long a peer snapshot is reused before the server is queried again. */
  readonly ttlMs: number
  /** Sessions not seen for longer than this are hidden unless they are running. */
  readonly idleWindowMs: number
  /** Upper bound for the list handed to the model. */
  readonly maxPeers: number
}

export interface PeerQuery {
  readonly self?: string
  readonly scope: "project" | "directory"
  readonly includeIdle: boolean
}

const SESSION_ID = /^ses_/

export function isSessionID(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value)
}

export function handleOf(id: string): string {
  return id.slice(0, 14)
}

export class Registry {
  readonly #api: Api
  readonly #scope: { readonly projectID?: string; readonly directory: string }
  readonly #options: RegistryOptions
  readonly #index = new Map<string, IndexedSession>()
  readonly #running = new Set<string>()
  #cache: { at: number; peers: readonly Peer[] } | undefined
  #inflight: Promise<readonly Peer[]> | undefined

  constructor(api: Api, scope: { projectID?: string; directory: string }, options: RegistryOptions) {
    this.#api = api
    this.#scope = scope
    this.#options = options
  }

  invalidate(): void {
    this.#cache = undefined
  }

  info(sessionID: string): IndexedSession | undefined {
    return this.#index.get(sessionID)
  }

  /** True when the session is a child of another session (task subagent, explore, ...). */
  isSubsession(sessionID: string): boolean {
    const info = this.#index.get(sessionID)
    return info !== undefined && info.parentID !== undefined
  }

  /** Seed the index from an event payload without waiting for the next refresh. */
  note(info: IndexedSession, running?: boolean): void {
    const previous = this.#index.get(info.id)
    const defined = Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined))
    if (previous || defined["title"] !== undefined || defined["location"] !== undefined) {
      this.#index.set(info.id, { ...previous, ...defined } as IndexedSession)
    }
    if (running !== undefined) {
      if (running) this.#running.add(info.id)
      else this.#running.delete(info.id)
    }
  }

  async peers(query: PeerQuery): Promise<readonly Peer[]> {
    const all = await this.all()
    return all
      .filter((peer) => peer.id !== query.self)
      .filter((peer) => query.scope === "project" || peer.directory === this.#scope.directory)
      .filter((peer) => query.includeIdle || peer.running || Date.now() - peer.updated < this.#options.idleWindowMs)
      .slice(0, this.#options.maxPeers)
  }

  async all(signal?: AbortSignal): Promise<readonly Peer[]> {
    const now = Date.now()
    if (this.#cache && now - this.#cache.at < this.#options.ttlMs) return this.#cache.peers
    if (this.#inflight) return this.#inflight
    const inflight = this.#load(signal)
      .then((peers) => {
        this.#cache = { at: Date.now(), peers }
        return peers
      })
      .finally(() => {
        this.#inflight = undefined
      })
    this.#inflight = inflight
    return inflight
  }

  async #load(signal?: AbortSignal): Promise<readonly Peer[]> {
    const filter = this.#scope.projectID
      ? { project: this.#scope.projectID, limit: 200 }
      : { directory: this.#scope.directory, limit: 200 }
    const [sessions, active] = await Promise.all([
      this.#api.get<readonly SessionInfo[]>("/api/session", filter, signal),
      this.#api
        .get<Readonly<Record<string, { readonly type?: string }>>>("/api/session/active", undefined, signal)
        .catch(() => ({}) as Readonly<Record<string, { readonly type?: string }>>),
    ])

    const running = new Set(
      Object.entries(active ?? {})
        .filter(([, value]) => value?.type === "running")
        .map(([id]) => id),
    )
    for (const session of sessions ?? []) {
      this.#index.set(session.id, session)
      if (running.has(session.id)) this.#running.add(session.id)
      else this.#running.delete(session.id)
    }

    return (sessions ?? [])
      .filter((session) => !session.parentID && !session.time?.archived)
      .map((session) => toPeer(session, running.has(session.id)))
      .sort((left, right) => Number(right.running) - Number(left.running) || right.updated - left.updated)
  }
}

function toPeer(session: SessionInfo, running: boolean): Peer {
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

export function describePeer(peer: Peer, now = Date.now()): string {
  const status = peer.running ? "working now" : `idle, seen ${humanAge(peer.updated, now)}`
  const agent = peer.agent ? `, agent ${peer.agent}` : ""
  return `${peer.handle} "${truncate(peer.title, 70)}"${agent}, ${status}`
}
