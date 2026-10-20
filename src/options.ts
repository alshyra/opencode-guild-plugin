import { DEFAULT_HALF_LIFE_DAYS, DEFAULT_STALE_DAYS } from "./memory"

export interface SessionBusOptions {
  /** Ask the user before the first message to a given session. */
  readonly permission: "ask" | "allow" | "deny"
  /** Which sessions count as peers: the same folder, or every checkout of the project. */
  readonly scope: "project" | "directory"
  /** Deliver the message into the peer's running turn, or park it in the queue. */
  readonly delivery: "steer" | "queue"
  /** Inject the live peer list into the system prompt of every request. */
  readonly injectPeers: boolean
  /** Show the linked sessions in the sidebar (the peer tools stay available). */
  readonly tuiPeers: boolean
  /** Long-term memory of the folder: memory_write / memory_read / memory_forget. */
  readonly memory: boolean
  /** Inject the folder memory into the system prompt of every request. */
  readonly injectMemory: boolean
  /** Include peers that are idle for longer than the idle window. */
  readonly includeIdle: boolean
  /** Mirror plugin logs into ~/.local/state/opencode/guild.log. */
  readonly debug: boolean
  readonly idleWindowMinutes: number
  readonly maxPeers: number
  readonly maxMessageChars: number
  readonly maxMessagesPerMinute: number
  readonly maxHop: number
  readonly cacheTtlSeconds: number
  /** Default wait for peers_ask, in seconds. */
  readonly askTimeoutSeconds: number
  /** Default number of entries peers_activity reports. */
  readonly activityLines: number
  /** Default number of memory entries injected into the system prompt. */
  readonly memoryInjectLines: number
  /** Upper bound for the folder memory file. */
  readonly memoryMaxEntries: number
  /** Longest text a single memory entry may hold. */
  readonly memoryMaxChars: number
  /** Suggest a compression once the memory holds this many entries. 0 disables the nudge. */
  readonly memoryCompressAfter: number
  /** Days after which a fact never seen again counts for half as much. 0 disables the decay. */
  readonly memoryHalfLifeDays: number
  /** Days after which a never-reinforced fact is reported as stale. 0 disables the notion. */
  readonly memoryStaleDays: number
  /** Suggest elevating a fact to a standing rule once it came back this many times. */
  readonly memoryPromoteAfter: number
}

export const defaultOptions: SessionBusOptions = {
  permission: "ask",
  scope: "directory",
  delivery: "steer",
  injectPeers: true,
  tuiPeers: true,
  memory: true,
  injectMemory: true,
  includeIdle: false,
  debug: false,
  idleWindowMinutes: 15,
  maxPeers: 12,
  maxMessageChars: 4000,
  maxMessagesPerMinute: 10,
  maxHop: 3,
  cacheTtlSeconds: 5,
  askTimeoutSeconds: 180,
  activityLines: 12,
  memoryInjectLines: 5,
  memoryMaxEntries: 500,
  memoryMaxChars: 2000,
  memoryCompressAfter: 60,
  memoryHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  memoryStaleDays: DEFAULT_STALE_DAYS,
  memoryPromoteAfter: 3,
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Same as `positive`, but 0 is a meaningful value (it turns a feature off). */
function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

export function resolveOptions(raw: Readonly<Record<string, unknown>>): SessionBusOptions {
  return {
    permission: pick(raw["permission"], ["ask", "allow", "deny"] as const, defaultOptions.permission),
    scope: pick(raw["scope"], ["project", "directory"] as const, defaultOptions.scope),
    delivery: pick(raw["delivery"], ["steer", "queue"] as const, defaultOptions.delivery),
    injectPeers: boolean(raw["injectPeers"], defaultOptions.injectPeers),
    tuiPeers: boolean(raw["tuiPeers"], defaultOptions.tuiPeers),
    memory: boolean(raw["memory"], defaultOptions.memory),
    injectMemory: boolean(raw["injectMemory"], defaultOptions.injectMemory),
    includeIdle: boolean(raw["includeIdle"], defaultOptions.includeIdle),
    debug: boolean(raw["debug"], defaultOptions.debug),
    idleWindowMinutes: positive(raw["idleWindowMinutes"], defaultOptions.idleWindowMinutes),
    maxPeers: positive(raw["maxPeers"], defaultOptions.maxPeers),
    maxMessageChars: positive(raw["maxMessageChars"], defaultOptions.maxMessageChars),
    maxMessagesPerMinute: positive(raw["maxMessagesPerMinute"], defaultOptions.maxMessagesPerMinute),
    maxHop: positive(raw["maxHop"], defaultOptions.maxHop),
    cacheTtlSeconds: positive(raw["cacheTtlSeconds"], defaultOptions.cacheTtlSeconds),
    askTimeoutSeconds: positive(raw["askTimeoutSeconds"], defaultOptions.askTimeoutSeconds),
    activityLines: positive(raw["activityLines"], defaultOptions.activityLines),
    memoryInjectLines: positive(raw["memoryInjectLines"], defaultOptions.memoryInjectLines),
    memoryMaxEntries: positive(raw["memoryMaxEntries"], defaultOptions.memoryMaxEntries),
    memoryMaxChars: positive(raw["memoryMaxChars"], defaultOptions.memoryMaxChars),
    memoryCompressAfter: nonNegative(raw["memoryCompressAfter"], defaultOptions.memoryCompressAfter),
    memoryHalfLifeDays: nonNegative(raw["memoryHalfLifeDays"], defaultOptions.memoryHalfLifeDays),
    memoryStaleDays: nonNegative(raw["memoryStaleDays"], defaultOptions.memoryStaleDays),
    memoryPromoteAfter: positive(raw["memoryPromoteAfter"], defaultOptions.memoryPromoteAfter),
  }
}
