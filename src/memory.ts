import { createHash, randomBytes } from "node:crypto"
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { log, truncate, warn } from "./log"

/** How many pre-rewrite snapshots stay in `history/`. */
const ARCHIVE_KEEP = 5

const DAY_MS = 86_400_000

/** Default half-life of a fact that is never seen again, in days. */
export const DEFAULT_HALF_LIFE_DAYS = 30

/** Default age after which a never-reinforced fact is called stale, in days. */
export const DEFAULT_STALE_DAYS = 45

/** One durable fact, decision or convention recorded by a session. */
export interface MemoryEntry {
  readonly id: string
  readonly at: number
  readonly session: string
  readonly title: string
  readonly agent?: string
  readonly text: string
  readonly tags: readonly string[]
  /** Stable handle: writing again with the same key replaces the entry. */
  readonly key?: string
  /** Pinned entries survive the cap and come first in the injected block. */
  readonly pinned: boolean
  /**
   * How many times the same fact came back, or how many entries a merge folded
   * into this one. The second-brain weight: reinforced facts outrank one-off
   * notes when the injected block has to choose.
   */
  readonly hits?: number
  /** Ids this entry came out of: a consolidation trail, not a strict parent link. */
  readonly mergedFrom?: readonly string[]
}

export interface MemoryInput {
  readonly session: string
  readonly title: string
  readonly agent?: string
  readonly text: string
  readonly tags: readonly string[]
  readonly key?: string
  readonly pinned: boolean
}

export interface MemoryOptions {
  /** Upper bound for the file: beyond it the oldest unpinned entries are dropped. */
  readonly maxEntries: number
  /** Longest text a single entry may hold. */
  readonly maxTextChars: number
  /** How long a read snapshot is reused. */
  readonly ttlMs: number
}

export interface MemoryWriteResult {
  readonly entry: MemoryEntry
  /** True when the same text was already recorded: nothing was added, its weight grew. */
  readonly duplicate: boolean
  /** True when the key replaced an existing entry. */
  readonly replaced: boolean
  /** Entries dropped by the cap. */
  readonly dropped: number
  readonly total: number
}

export type MemoryForgetResult =
  | { readonly removed: readonly MemoryEntry[]; readonly archive?: string }
  | { readonly error: string }

/** Flipping the standing-rule flag of one entry: the elevation. */
export type MemoryPromoteResult =
  | { readonly entry: MemoryEntry; readonly changed: boolean; readonly archive?: string }
  | { readonly error: string }

/** One entry to add during a rewrite: the store fills identity, dates and ids. */
export interface MemoryDigest {
  readonly text: string
  readonly tags: readonly string[]
  readonly key?: string
}

export interface MemoryReplaceInput {
  /** Ids, keys or unambiguous text fragments of the entries to drop. */
  readonly remove: readonly string[]
  readonly add: readonly MemoryDigest[]
  readonly session: string
  readonly title: string
  readonly agent?: string
  /** Resolve and report without writing anything. */
  readonly dryRun?: boolean
}

export type MemoryReplaceResult =
  | {
      readonly removed: readonly MemoryEntry[]
      readonly added: readonly MemoryEntry[]
      readonly total: number
      /** Path of the archive taken before the rewrite. */
      readonly archive?: string
    }
  | { readonly error: string }

/** A memory entry is a line a colleague reads: a handful of labels is enough. */
export const MAX_TAGS = 8

/** Root of the per-folder memory: `~/.opencode/session-bus/<hash>/`. */
export function memoryRoot(home: string = homedir()): string {
  return join(home, ".opencode", "session-bus")
}

/** Stable key for a working folder: the folder itself is the scope. */
export function directoryKey(directory: string): string {
  return createHash("sha1").update(resolve(directory)).digest("hex")
}

export function memoryDirectory(directory: string, root: string = memoryRoot()): string {
  return join(root, directoryKey(directory))
}

export function memoryFile(directory: string, root: string = memoryRoot()): string {
  return join(memoryDirectory(directory, root), "memory.jsonl")
}

/**
 * Append-only memory of one working folder, shared by every session working
 * there. Reads are cached for a few seconds; writes append, and only rewrite
 * the file when a key is replaced or the cap is reached.
 */
export class MemoryStore {
  readonly #directory: string
  readonly #options: MemoryOptions
  #entries: readonly MemoryEntry[] = []
  #at = 0
  #loaded = false
  #warned = false

  constructor(directory: string, options: MemoryOptions) {
    this.#directory = directory
    this.#options = options
  }

  get file(): string {
    return memoryFile(this.#directory)
  }

  /** Newest snapshot, at most `ttlMs` old. */
  all(): readonly MemoryEntry[] {
    if (this.#loaded && Date.now() - this.#at < this.#options.ttlMs) return this.#entries
    const entries = this.#read()
    this.#entries = entries
    this.#at = Date.now()
    this.#loaded = true
    return entries
  }

  write(input: MemoryInput): MemoryWriteResult {
    // Always work on what is on disk: another service may have appended since
    // the last read, and a rewrite must not drop its entry.
    const entries = this.#read()
    const text = input.text.trim()
    const key = input.key?.trim() || undefined

    if (!key) {
      const same = entries.find((entry) => normalize(entry.text) === normalize(text))
      if (same) {
        // The same fact came back: that is the second-brain signal. Its weight
        // grows and it moves up in the injected block. Nothing is lost, so no
        // archive is written.
        const reinforced: MemoryEntry = { ...same, at: Date.now(), hits: (same.hits ?? 0) + 1 }
        const next = entries.map((entry) => (entry.id === same.id ? reinforced : entry))
        this.#rewrite(next, false)
        this.#entries = next
        this.#at = Date.now()
        this.#loaded = true
        log(`reinforced memory entry ${same.id} (${reinforced.hits} hits)`)
        return { entry: reinforced, duplicate: true, replaced: false, dropped: 0, total: next.length }
      }
    }

    const replaced = key ? entries.find((existing) => existing.key === key) : undefined

    const entry: MemoryEntry = {
      id: newID(),
      at: Date.now(),
      session: input.session,
      title: input.title,
      ...(input.agent ? { agent: input.agent } : {}),
      text,
      tags: input.tags,
      ...(key ? { key } : {}),
      pinned: input.pinned,
      // A key carries a fact that evolves: the replacement inherits the weight
      // of the entry it supersedes.
      ...(replaced ? { hits: (replaced.hits ?? 0) + 1 } : {}),
    }

    const kept = replaced ? entries.filter((existing) => existing !== replaced) : [...entries]
    kept.push(entry)
    const compacted = compact(kept, this.#options.maxEntries)
    const dropped = kept.length - compacted.length

    if (replaced !== undefined || dropped > 0) this.#rewrite(compacted)
    else this.#append(entry)
    this.#entries = compacted
    this.#at = Date.now()
    this.#loaded = true
    return {
      entry,
      duplicate: false,
      replaced: replaced !== undefined,
      dropped,
      total: compacted.length,
    }
  }

  forget(target: string): MemoryForgetResult {
    const wanted = target.trim()
    const entries = this.#read()
    const matches = matchEntries(entries, wanted)
    if (matches.length === 0) {
      return { error: `No memory entry matches "${wanted}" (use memory_read to get the ids).` }
    }
    if (matches.length > 1) {
      return {
        error: `${matches.length} entries match "${wanted}": give the full id (${matches.map((entry) => entry.id).join(", ")}).`,
      }
    }
    const removed = matches[0] as MemoryEntry
    const kept = entries.filter((entry) => entry.id !== removed.id)
    const archive = this.#rewrite(kept)
    this.#entries = kept
    this.#at = Date.now()
    this.#loaded = true
    log(`forgot memory entry ${removed.id} (${kept.length} left)`)
    return { removed: [removed], archive }
  }

  /**
   * Drops the entries matching `remove` and adds the digests in one write: the
   * primitive behind `memory_rewrite` and the compression. Nothing is written
   * when a target does not resolve: the caller gets the list and can retry.
   */
  replace(input: MemoryReplaceInput): MemoryReplaceResult {
    const entries = this.#read()
    const removed: MemoryEntry[] = []
    const unknown: string[] = []
    for (const target of input.remove) {
      const matches = matchEntries(entries, target.trim())
      if (matches.length !== 1) {
        unknown.push(matches.length === 0 ? target : `${target} (${matches.length} matches)`)
        continue
      }
      const entry = matches[0] as MemoryEntry
      if (!removed.includes(entry)) removed.push(entry)
    }
    if (unknown.length > 0) {
      return {
        error: `Nothing was rewritten: no single entry matches ${unknown.map((item) => `"${item}"`).join(", ")}. Read the ids with memory_read first.`,
      }
    }

    const replacedAt = Date.now()
    const added: MemoryEntry[] = input.add.map((digest) => {
      // A merge folds weights together: the consolidated entry keeps what its
      // parents had earned.
      const inherited = removed.reduce((sum, entry) => sum + (entry.hits ?? 0), 0)
      return {
        id: newID(),
        at: replacedAt,
        session: input.session,
        title: input.title,
        ...(input.agent ? { agent: input.agent } : {}),
        text: digest.text.trim(),
        tags: digest.tags,
        ...(digest.key ? { key: digest.key } : {}),
        pinned: false,
        ...(inherited > 0 ? { hits: inherited } : {}),
        ...(removed.length > 0 ? { mergedFrom: removed.map((entry) => entry.id) } : {}),
      }
    })

    const gone = new Set(removed.map((entry) => entry.id))
    const next = compact([...entries.filter((entry) => !gone.has(entry.id)), ...added], this.#options.maxEntries)
    if (input.dryRun) {
      return { removed, added, total: next.length }
    }
    const archive = this.#rewrite(next)
    this.#entries = next
    this.#at = Date.now()
    this.#loaded = true
    log(`rewrote memory: -${removed.length} +${added.length} entries (${next.length} total)`)
    return { removed, added, total: next.length, ...(archive ? { archive } : {}) }
  }

  /**
   * Flips the standing-rule flag of one entry. Promotion is the elevation: the
   * caller asks the user first. Demotion is the only losing direction, so it
   * archives like a removal.
   */
  promote(target: string, pinned: boolean): MemoryPromoteResult {
    const entries = this.#read()
    const matches = matchEntries(entries, target.trim())
    if (matches.length !== 1) {
      return {
        error:
          matches.length === 0
            ? `No memory entry matches "${target.trim()}" (use memory_read to get the ids).`
            : `${matches.length} entries match "${target.trim()}": give the full id.`,
      }
    }
    const entry = matches[0] as MemoryEntry
    if (entry.pinned === pinned) return { entry, changed: false }
    const promoted: MemoryEntry = { ...entry, pinned }
    const next = entries.map((candidate) => (candidate.id === entry.id ? promoted : candidate))
    const archive = this.#rewrite(next, !pinned)
    this.#entries = next
    this.#at = Date.now()
    this.#loaded = true
    log(`${pinned ? "promoted" : "demoted"} memory entry ${entry.id}`)
    return { entry: promoted, changed: true, ...(archive ? { archive } : {}) }
  }

  #read(): readonly MemoryEntry[] {
    let raw: string
    try {
      raw = readFileSync(this.file, "utf8")
    } catch (cause) {
      if (!isMissing(cause)) this.#report(cause)
      return []
    }
    return parseEntries(raw)
  }

  #append(entry: MemoryEntry): void {
    try {
      mkdirSync(memoryDirectory(this.#directory), { recursive: true, mode: 0o700 })
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch (cause) {
      this.#report(cause)
    }
  }

  /**
   * Full rewrite. `archive` defaults to true, because a rewrite is the only
   * thing that can lose an entry: the previous file stays in `history/`. Pass
   * false for a pure reinforcement (a weight or a flag that only goes up), so
   * `history/` keeps marking the states where something disappeared.
   */
  #rewrite(entries: readonly MemoryEntry[], archive = true): string | undefined {
    try {
      mkdirSync(memoryDirectory(this.#directory), { recursive: true, mode: 0o700 })
      const archived = archive ? this.#archive() : undefined
      const temporary = `${this.file}.tmp`
      const body = entries.map((entry) => JSON.stringify(entry)).join("\n")
      writeFileSync(temporary, body ? `${body}\n` : "", { mode: 0o600 })
      renameSync(temporary, this.file)
      return archived
    } catch (cause) {
      this.#report(cause)
      return undefined
    }
  }

  /** Copies the current file into `history/<timestamp>.jsonl`, keeping the last five. */
  #archive(): string | undefined {
    let body: string
    try {
      body = readFileSync(this.file, "utf8")
    } catch (cause) {
      if (!isMissing(cause)) this.#report(cause)
      return undefined
    }
    if (!body.trim()) return undefined
    const directory = join(memoryDirectory(this.#directory), "history")
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // Two rewrites can land in the same millisecond: the suffix keeps the
    // generations distinct instead of overwriting one with the other.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const file = join(directory, `${stamp}-${randomBytes(3).toString("hex")}.jsonl`)
    writeFileSync(file, body, { mode: 0o600 })
    const stale = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .reverse()
      .slice(ARCHIVE_KEEP)
    for (const name of stale) unlinkSync(join(directory, name))
    return file
  }

  #report(cause: unknown): void {
    if (this.#warned) return
    this.#warned = true
    warn(`folder memory unavailable at ${this.file}`, cause)
  }
}

/** Reads the JSONL body, ignoring the lines a concurrent write may have torn. */
export function parseEntries(raw: string): readonly MemoryEntry[] {
  const entries: MemoryEntry[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const entry = toEntry(parsed)
    if (entry) entries.push(entry)
  }
  return entries.sort((left, right) => left.at - right.at)
}

/**
 * Resolves entries from an id, an id prefix, a key or — only when nothing
 * identifies the entry directly — a fragment of its text. Returns every
 * candidate, so the caller can refuse an ambiguous target.
 */
export function matchEntries(entries: readonly MemoryEntry[], target: string): readonly MemoryEntry[] {
  const wanted = target.trim()
  if (!wanted) return []
  const byID = entries.filter(
    (entry) => entry.id === wanted || (/^mem_/.test(wanted) && entry.id.startsWith(wanted)),
  )
  if (byID.length > 0) return byID
  const byKey = entries.filter((entry) => entry.key === wanted)
  if (byKey.length > 0) return byKey
  const needle = normalize(wanted)
  return entries.filter((entry) => normalize(entry.text).includes(needle))
}

/**
 * Weight a fact earned: repeated writes, plus the entries a merge folded into
 * it, halved every `halfLifeDays` without being seen again. The counters never
 * decay — only the ranking does, so a fact that keeps coming back stays on top
 * and an old one slowly loses its place. `halfLifeDays: 0` returns the raw
 * weight. Pinned entries are handled separately: a standing rule outranks any
 * count.
 */
export function memoryWeight(entry: MemoryEntry, now = Date.now(), halfLifeDays = DEFAULT_HALF_LIFE_DAYS): number {
  const raw = (entry.hits ?? 0) + (entry.mergedFrom?.length ?? 0)
  if (halfLifeDays <= 0) return raw
  const age = Math.max(0, now - entry.at)
  return raw * 0.5 ** (age / (halfLifeDays * DAY_MS))
}

/**
 * A candidate for housekeeping, never a deletion: a note nobody ever came back
 * to, old enough to be suspect. A pinned entry is never stale, and neither is an
 * entry that was reinforced — coming back is what keeps a fact alive.
 */
export function isStale(entry: MemoryEntry, now = Date.now(), staleDays = DEFAULT_STALE_DAYS): boolean {
  if (staleDays <= 0 || entry.pinned || (entry.hits ?? 0) > 0) return false
  return now - entry.at > staleDays * DAY_MS
}

/** Pinned first, then the weight the fact earned (decayed), then the most recent. */
export function selectEntries(
  entries: readonly MemoryEntry[],
  query: string | undefined,
  tags: readonly string[],
  limit: number,
  ranking?: { readonly now?: number; readonly halfLifeDays?: number },
): readonly MemoryEntry[] {
  const now = ranking?.now ?? Date.now()
  const halfLifeDays = ranking?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
  const needle = query?.trim().toLowerCase()
  const wanted = tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
  return entries
    .filter((entry) => wanted.every((tag) => entry.tags.some((own) => own.toLowerCase() === tag)))
    .filter((entry) => {
      if (!needle) return true
      const haystack = [entry.text, entry.key ?? "", entry.title, entry.session, ...entry.tags].join(" ").toLowerCase()
      return haystack.includes(needle)
    })
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        memoryWeight(right, now, halfLifeDays) - memoryWeight(left, now, halfLifeDays) ||
        right.at - left.at,
    )
    .slice(0, limit)
}

/** How many topics the injected block advertises. */
export const MAX_TOPICS = 10

/**
 * The tags the memory actually carries, most used first: what a session can
 * expect to find here, and the words worth searching with. Computed from the
 * whole memory, not from the handful of entries a capped block shows, so the
 * index stays honest about what exists beyond the visible lines.
 */
export function topicsOf(
  entries: readonly MemoryEntry[],
  limit = MAX_TOPICS,
): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const key = tag.trim().toLowerCase()
      if (!key) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
}

/** `×3` when a fact came back, so the weight is visible wherever entries are listed. */
export function weightMark(entry: MemoryEntry): string {
  const hits = entry.hits ?? 0
  return hits > 1 ? `×${hits} ` : ""
}

export function describeEntry(
  entry: MemoryEntry,
  maxText: number,
  now = Date.now(),
  staleDays = DEFAULT_STALE_DAYS,
): string {
  const tags = entry.tags.length ? ` (tags: ${entry.tags.join(", ")})` : ""
  const pin = entry.pinned ? "pinned, " : ""
  const stale = isStale(entry, now, staleDays) ? "stale " : ""
  return (
    `${stale}${entry.id} [${dateOf(entry.at)}, ${pin}${weightMark(entry)}from "${truncate(entry.title, 40)}"] ` +
    `${truncate(entry.text, maxText)}${tags}`
  )
}

/** Compact one-liner used by the injected block. */
export function summarizeEntry(
  entry: MemoryEntry,
  maxText: number,
  now = Date.now(),
  staleDays = DEFAULT_STALE_DAYS,
): string {
  const tags = entry.tags.length ? ` (${entry.tags.join(", ")})` : ""
  const pin = entry.pinned ? "pinned " : ""
  const stale = isStale(entry, now, staleDays) ? "stale " : ""
  return `- ${stale}${pin}${weightMark(entry)}[${dateOf(entry.at)}] ${truncate(entry.text, maxText)}${tags}`
}

export function dateOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase()
}

function newID(): string {
  return `mem_${randomBytes(5).toString("hex")}`
}

function compact(entries: readonly MemoryEntry[], max: number): readonly MemoryEntry[] {
  if (entries.length <= max) return [...entries].sort((left, right) => left.at - right.at)
  const recent = [...entries].sort((left, right) => right.at - left.at)
  const keep = new Set<string>()
  for (const entry of recent) {
    if (entry.pinned && keep.size < max) keep.add(entry.id)
  }
  for (const entry of recent) {
    if (keep.size >= max) break
    keep.add(entry.id)
  }
  return entries.filter((entry) => keep.has(entry.id)).sort((left, right) => left.at - right.at)
}

function toEntry(value: unknown): MemoryEntry | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const id = raw["id"]
  const text = raw["text"]
  if (typeof id !== "string" || !id || typeof text !== "string" || !text.trim()) return undefined
  return {
    id,
    at: typeof raw["at"] === "number" && Number.isFinite(raw["at"]) ? raw["at"] : 0,
    session: typeof raw["session"] === "string" ? raw["session"] : "unknown",
    title: typeof raw["title"] === "string" ? raw["title"] : "(untitled)",
    ...(typeof raw["agent"] === "string" ? { agent: raw["agent"] } : {}),
    text: text.trim(),
    tags: Array.isArray(raw["tags"]) ? raw["tags"].filter((tag): tag is string => typeof tag === "string") : [],
    ...(typeof raw["key"] === "string" && raw["key"] ? { key: raw["key"] } : {}),
    pinned: raw["pinned"] === true,
    ...(typeof raw["hits"] === "number" && raw["hits"] > 0 ? { hits: Math.round(raw["hits"]) } : {}),
    ...(Array.isArray(raw["mergedFrom"])
      ? { mergedFrom: raw["mergedFrom"].filter((id): id is string => typeof id === "string") }
      : {}),
  }
}

function isMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "ENOENT"
}
