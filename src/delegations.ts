import { randomBytes } from "node:crypto"

/** How many delegations stay queryable before the oldest resolved ones are dropped. */
const KEEP = 200

export interface Delegation {
  readonly id: string
  /** Session that asked. */
  readonly requester: string
  /** Session that was asked. */
  readonly peer: string
  readonly task: string
  readonly at: number
  /** Set when a message came back from the peer. */
  readonly resolvedAt?: number
}

export interface DelegationInput {
  readonly requester: string
  readonly peer: string
  readonly task: string
  readonly now?: number
}

/**
 * Outstanding asynchronous delegations. The report back is an ordinary peer
 * message; this registry only remembers the exchange, so a session can see what
 * it is still waiting for and the plugin can tell a report from a stray message.
 * It is in memory only: losing it costs visibility, never a delivery. A message
 * from the asked peer to the requester is what resolves a delegation, which is
 * also what resumes the requester.
 */
export class Delegations {
  readonly #all = new Map<string, Delegation>()

  register(input: DelegationInput): Delegation {
    const delegation: Delegation = {
      id: `dlg_${randomBytes(5).toString("hex")}`,
      requester: input.requester,
      peer: input.peer,
      task: input.task,
      at: input.now ?? Date.now(),
    }
    this.#all.set(delegation.id, delegation)
    this.#trim()
    return delegation
  }

  /** Drops a delegation that never made it out (the delivery failed). */
  forget(id: string): void {
    this.#all.delete(id)
  }

  /** The oldest unanswered delegation between these two sessions, now marked answered. */
  resolve(requester: string, peer: string, now = Date.now()): Delegation | undefined {
    let oldest: Delegation | undefined
    for (const delegation of this.#all.values()) {
      if (delegation.requester !== requester || delegation.peer !== peer || delegation.resolvedAt) continue
      if (!oldest || delegation.at < oldest.at) oldest = delegation
    }
    if (!oldest) return undefined
    const resolved: Delegation = { ...oldest, resolvedAt: now }
    this.#all.set(oldest.id, resolved)
    return resolved
  }

  get(id: string): Delegation | undefined {
    return this.#all.get(id)
  }

  /** What a session is still waiting on, oldest first. */
  pending(requester: string): readonly Delegation[] {
    return [...this.#all.values()]
      .filter((delegation) => delegation.requester === requester && !delegation.resolvedAt)
      .sort((left, right) => left.at - right.at)
  }

  /** Bounded: hook identity lives for the whole service, so nothing may grow forever. */
  #trim(): void {
    if (this.#all.size <= KEEP) return
    const oldest = [...this.#all.values()].sort((left, right) => left.at - right.at)
    for (const delegation of oldest) {
      if (this.#all.size <= KEEP) return
      if (!delegation.resolvedAt) continue
      this.#all.delete(delegation.id)
    }
    // A stream of never-answered delegations still has to be bounded.
    for (const delegation of oldest) {
      if (this.#all.size <= KEEP) return
      this.#all.delete(delegation.id)
    }
  }
}
