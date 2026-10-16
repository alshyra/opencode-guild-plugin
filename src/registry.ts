import type { Api } from "./api"
import { type IndexedSession, type Peer, type SessionLike, selectPeers } from "./peers"
import { warn } from "./log"

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

export interface RegistryScope {
  readonly projectID?: string
  readonly directory: string
}

interface Snapshot {
  readonly at: number
  readonly sessions: readonly SessionLike[]
  readonly running: ReadonlySet<string>
}

/**
 * Session discovery for one location. The plugin context cannot list sessions,
 * so peers come from the local HTTP API, cached for a few seconds.
 */
export class Registry {
  readonly #api: Api
  readonly #scope: RegistryScope
  readonly #options: RegistryOptions
  readonly #index = new Map<string, IndexedSession>()
  #snapshot: Snapshot | undefined
  #inflight: Promise<Snapshot> | undefined

  constructor(api: Api, scope: RegistryScope, options: RegistryOptions) {
    this.#api = api
    this.#scope = scope
    this.#options = options
  }

  invalidate(): void {
    this.#snapshot = undefined
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
  note(info: IndexedSession): void {
    const previous = this.#index.get(info.id)
    const defined = Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined))
    if (previous || defined["title"] !== undefined || defined["location"] !== undefined) {
      this.#index.set(info.id, { ...previous, ...defined } as IndexedSession)
    }
  }

  async peers(query: PeerQuery): Promise<readonly Peer[]> {
    const snapshot = await this.#refresh()
    return selectPeers(snapshot.sessions, {
      self: query.self,
      scope: query.scope,
      directory: this.#scope.directory,
      includeIdle: query.includeIdle,
      idleWindowMs: this.#options.idleWindowMs,
      maxPeers: this.#options.maxPeers,
      running: snapshot.running,
      now: snapshot.at,
    })
  }

  /** Raw session list of the project, including subagents and archived sessions. */
  async sessions(): Promise<readonly SessionLike[]> {
    return (await this.#refresh()).sessions
  }

  async #refresh(): Promise<Snapshot> {
    const cached = this.#snapshot
    if (cached && Date.now() - cached.at < this.#options.ttlMs) return cached
    if (this.#inflight) return this.#inflight
    const inflight = this.#load()
      .then((snapshot) => {
        this.#snapshot = snapshot
        return snapshot
      })
      .catch((cause: unknown) => {
        if (cached) {
          warn("peer refresh failed, keeping the previous list", cause)
          return cached
        }
        throw cause
      })
      .finally(() => {
        this.#inflight = undefined
      })
    this.#inflight = inflight
    return inflight
  }

  async #load(): Promise<Snapshot> {
    const filter = this.#scope.projectID
      ? { project: this.#scope.projectID, limit: 200 }
      : { directory: this.#scope.directory, limit: 200 }
    const [sessions, active] = await Promise.all([
      this.#api.get<readonly SessionLike[]>("/api/session", filter),
      this.#api
        .get<Readonly<Record<string, { readonly type?: string }>>>("/api/session/active")
        .catch(() => ({}) as Readonly<Record<string, { readonly type?: string }>>),
    ])

    const running = new Set(
      Object.entries(active ?? {})
        .filter(([, value]) => value?.type === "running")
        .map(([id]) => id),
    )
    for (const session of sessions ?? []) this.#index.set(session.id, session)
    return { at: Date.now(), sessions: sessions ?? [], running }
  }
}
