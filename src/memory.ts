import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { truncate, warn } from "./log"

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
  /** True when the same text was already recorded: nothing was written. */
  readonly duplicate: boolean
  /** True when the key replaced an existing entry. */
  readonly replaced: boolean
  /** Entries dropped by the cap. */
  readonly dropped: number
  readonly total: number
}

export type MemoryForgetResult =
  | { readonly removed: readonly MemoryEntry[] }
  | { readonly error: string }

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
      if (same) return { entry: same, duplicate: true, replaced: false, dropped: 0, total: entries.length }
    }

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
    }

    const replaced = key ? entries.find((existing) => existing.key === key) : undefined
    const kept = replaced ? entries.filter((existing) => existing !== replaced) : [...entries]
    kept.push(entry)
    const compacted = compact(kept, this.#options.maxEntries)
    const dropped = kept.length - compacted.length

    this.#save(compacted, replaced !== undefined || dropped > 0 ? "rewrite" : "append", entry)
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
    // Precedence: id, then key, then a fragment of the text. A fragment only
    // wins when nothing identifies the entry directly, so that a short text
    // never hides an exact id or key.
    const byID = entries.filter(
      (entry) => entry.id === wanted || (/^mem_/.test(wanted) && entry.id.startsWith(wanted)),
    )
    const byKey = entries.filter((entry) => entry.key === wanted)
    const direct = byID.length > 0 ? byID : byKey
    const matches =
      direct.length > 0
        ? direct
        : entries.filter((entry) => normalize(entry.text).includes(normalize(wanted)))
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
    this.#save(kept, "rewrite")
    this.#entries = kept
    this.#at = Date.now()
    this.#loaded = true
    return { removed: [removed] }
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

  #save(entries: readonly MemoryEntry[], mode: "append" | "rewrite", appended?: MemoryEntry): void {
    try {
      mkdirSync(memoryDirectory(this.#directory), { recursive: true, mode: 0o700 })
      if (mode === "append" && appended) {
        appendFileSync(this.file, `${JSON.stringify(appended)}\n`, { mode: 0o600 })
        return
      }
      const temporary = `${this.file}.tmp`
      const body = entries.map((entry) => JSON.stringify(entry)).join("\n")
      writeFileSync(temporary, body ? `${body}\n` : "", { mode: 0o600 })
      renameSync(temporary, this.file)
    } catch (cause) {
      this.#report(cause)
    }
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

/** Pinned first, then the most recent. */
export function selectEntries(
  entries: readonly MemoryEntry[],
  query: string | undefined,
  tags: readonly string[],
  limit: number,
): readonly MemoryEntry[] {
  const needle = query?.trim().toLowerCase()
  const wanted = tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
  return entries
    .filter((entry) => wanted.every((tag) => entry.tags.some((own) => own.toLowerCase() === tag)))
    .filter((entry) => {
      if (!needle) return true
      const haystack = [entry.text, entry.key ?? "", entry.title, entry.session, ...entry.tags].join(" ").toLowerCase()
      return haystack.includes(needle)
    })
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.at - left.at)
    .slice(0, limit)
}

export function describeEntry(entry: MemoryEntry, maxText: number): string {
  const tags = entry.tags.length ? ` (tags: ${entry.tags.join(", ")})` : ""
  const pin = entry.pinned ? "pinned, " : ""
  return (
    `${entry.id} [${dateOf(entry.at)}, ${pin}from "${truncate(entry.title, 40)}"] ` +
    `${truncate(entry.text, maxText)}${tags}`
  )
}

/** Compact one-liner used by the injected block. */
export function summarizeEntry(entry: MemoryEntry, maxText: number): string {
  const tags = entry.tags.length ? ` (${entry.tags.join(", ")})` : ""
  const pin = entry.pinned ? "pinned " : ""
  return `- ${pin}[${dateOf(entry.at)}] ${truncate(entry.text, maxText)}${tags}`
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
  }
}

function isMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "ENOENT"
}
