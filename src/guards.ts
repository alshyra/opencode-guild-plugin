export interface GuardOptions {
  readonly maxMessageChars: number
  readonly maxMessagesPerMinute: number
  readonly maxHop: number
}

interface Inbound {
  readonly from: string
  readonly hop: number
  readonly at: number
}

/**
 * Best-effort loop control. The plugin instance only sees deliveries it made,
 * so the hop counter is a heuristic across checkouts, backed by a hard rate
 * limit and by the "never relay a peer message" rule given to the model.
 */
export class Guards {
  readonly #sent = new Map<string, number[]>()
  readonly #inbound = new Map<string, Inbound>()
  readonly #compressions = new Map<string, number[]>()

  /** Number of peer hops this message would add to. */
  nextHop(sessionID: string, withinMs = 120_000): number {
    const inbound = this.#inbound.get(sessionID)
    if (!inbound) return 0
    if (Date.now() - inbound.at > withinMs) return 0
    return inbound.hop + 1
  }

  noteDelivery(to: string, from: string, hop: number): void {
    this.#inbound.set(to, { from, hop, at: Date.now() })
  }

  /** Throws when the sender exceeds its message budget. */
  assertRate(sessionID: string, options: GuardOptions): void {
    const now = Date.now()
    const recent = (this.#sent.get(sessionID) ?? []).filter((at) => now - at < 60_000)
    if (recent.length >= options.maxMessagesPerMinute) {
      throw new Error(
        `rate limit reached (${options.maxMessagesPerMinute} messages/minute). Report to the user instead of messaging another session again.`,
      )
    }
    recent.push(now)
    this.#sent.set(sessionID, recent)
  }

  /**
   * A compression is a model call, so a session cannot start them without
   * bound: a loop would burn tokens for no gain.
   */
  assertCompressAllowed(sessionID: string, maxPerMinute = 3): void {
    const now = Date.now()
    const recent = (this.#compressions.get(sessionID) ?? []).filter((at) => now - at < 60_000)
    if (recent.length >= maxPerMinute) {
      throw new Error(
        `already ${recent.length} memory compressions in the last minute in this session; report the result instead of compressing again.`,
      )
    }
    recent.push(now)
    this.#compressions.set(sessionID, recent)
  }
}
