import type { Ctx } from "./types"
import type { MemoryEntry, MemoryStore } from "./memory"
import type { SessionBusOptions } from "./options"
import { MAX_TAGS, dateOf } from "./memory"
import { log, warn } from "./log"

/** One entry the model proposes to keep after a consolidation. */
export interface DigestEntry {
  readonly text: string
  readonly tags: readonly string[]
  readonly key?: string
}

export interface ParseOptions {
  readonly maxTextChars: number
  readonly maxTags: number
}

export interface ParseResult {
  readonly entries: readonly DigestEntry[]
  /** Set when nothing usable could be extracted: the caller must write nothing. */
  readonly problem?: string
  /** Entries the model produced but that were unusable (empty, over-long, wrong shape). */
  readonly skipped?: number
}

export interface CompressDeps {
  readonly ctx: Ctx
  readonly memory: MemoryStore
  readonly options: SessionBusOptions
}

export interface CompressCaller {
  readonly sessionID: string
  readonly title: string
  readonly agent?: string
}

export interface CompressInput {
  readonly caller: CompressCaller
  /** Ask the model and report what would change, without touching the file. */
  readonly dryRun: boolean
  /** Extra instruction passed to the model, e.g. "keep the absolute paths". */
  readonly note?: string
}

export interface CompressReport {
  readonly applied: boolean
  readonly before: number
  readonly after: number
  /** How many non-pinned entries were sent to the model. */
  readonly pool: number
  readonly entries: readonly DigestEntry[]
  readonly removed: readonly string[]
  /** Keys that addressed a removed entry and no longer address anything. */
  readonly lostKeys: readonly string[]
  readonly skipped: number
  readonly archive?: string
  readonly problem?: string
}

const MAX_KEY_CHARS = 64

/**
 * Consolidates the folder memory: the non-pinned entries go to the model in one
 * auxiliary request (no session, no transcript), and its answer replaces them.
 * Pinned entries never take part, so a compression cannot touch them.
 */
export async function compressMemory(deps: CompressDeps, input: CompressInput): Promise<CompressReport> {
  const all = deps.memory.all()
  const pool = all.filter((entry) => !entry.pinned)
  const base = {
    before: all.length,
    after: all.length,
    pool: pool.length,
    entries: [],
    removed: [],
    lostKeys: [],
    skipped: 0,
  }
  if (pool.length < 2) {
    return {
      ...base,
      applied: false,
      problem: `the memory holds ${all.length} ${all.length === 1 ? "entry" : "entries"} and only ${pool.length} of them may be merged (pinned entries are never touched): nothing to compress`,
    }
  }

  let answer: string
  try {
    answer = (await deps.ctx.generate.text({ prompt: buildCompressionPrompt(pool, input.note) })).text
  } catch (cause) {
    warn("memory compression could not reach the model", cause)
    return { ...base, applied: false, problem: `the model call failed: ${errorText(cause)}` }
  }

  const parsed = parseCompression(answer, { maxTextChars: deps.options.memoryMaxChars, maxTags: MAX_TAGS })
  if (parsed.problem || parsed.entries.length === 0) {
    return { ...base, applied: false, problem: parsed.problem ?? "the model returned no usable entry" }
  }
  if (parsed.entries.length >= pool.length) {
    return {
      ...base,
      applied: false,
      entries: parsed.entries,
      removed: pool.map((entry) => entry.id),
      problem: `nothing to gain: the model returned ${parsed.entries.length} entries for ${pool.length}`,
    }
  }

  const after = all.length - pool.length + parsed.entries.length
  const skipped = parsed.skipped ?? 0
  if (input.dryRun) {
    log(`memory compression dry run: ${all.length} -> ${after} entries (${pool.length} sent)`)
    return {
      ...base,
      applied: false,
      after,
      entries: parsed.entries,
      removed: pool.map((entry) => entry.id),
      lostKeys: lostKeys(pool, parsed.entries),
      skipped,
    }
  }

  const result = deps.memory.replace({
    remove: pool.map((entry) => entry.id),
    add: parsed.entries,
    session: input.caller.sessionID,
    title: input.caller.title,
    ...(input.caller.agent ? { agent: input.caller.agent } : {}),
  })
  if ("error" in result) {
    return { ...base, applied: false, entries: parsed.entries, skipped, problem: result.error }
  }
  log(`compressed memory: ${all.length} -> ${result.total} entries (${result.removed.length} merged)`)
  return {
    applied: true,
    before: all.length,
    after: result.total,
    pool: pool.length,
    entries: parsed.entries,
    removed: result.removed.map((entry) => entry.id),
    lostKeys: lostKeys(result.removed, parsed.entries),
    skipped,
    ...(result.archive ? { archive: result.archive } : {}),
  }
}

/** A key that used to address a removed entry and that the merged entries do not carry. */
function lostKeys(removed: readonly MemoryEntry[], added: readonly DigestEntry[]): readonly string[] {
  const kept = new Set(added.map((entry) => entry.key).filter((key): key is string => Boolean(key)))
  return [...new Set(removed.map((entry) => entry.key).filter((key): key is string => Boolean(key)))].filter(
    (key) => !kept.has(key),
  )
}

/** The consolidation request. Entries arrive as `id | date | key | text | tags`. */
export function buildCompressionPrompt(entries: readonly MemoryEntry[], note?: string): string {
  return [
    "You are consolidating the long-term memory shared by the coding sessions of one folder.",
    "Each line below is one entry: id | date | key | text | tags. Every entry is worth keeping unless it repeats another one.",
    "",
    ...entries.map(
      (entry) =>
        `${entry.id} | ${dateOf(entry.at)} | ${entry.key ?? "-"} | ${entry.text.replace(/\s+/g, " ")} | ${entry.tags.join(", ") || "-"}`,
    ),
    "",
    "Rewrite this memory so that it stays as useful while taking less space:",
    "- merge entries that say the same thing, or nearly the same thing, into one entry;",
    "- keep every distinct fact, file path, command, port, name and decision, with enough context to be understood alone;",
    "- an entry that has a key keeps that key on the merged entry;",
    "- never invent a fact that is not in the list, never add advice, commentary or formatting;",
    "- keep each text to one or two sentences.",
    note ? `Additional instruction: ${note}` : "",
    "",
    'Answer with JSON only, without prose and without a code fence: {"entries":[{"text":"...","tags":["..."],"key":"optional"}]}',
  ]
    .filter((line) => line !== "")
    .join("\n")
}

/** Tolerant reader for the model answer: prose and code fences around the JSON are accepted. */
export function parseCompression(text: string, options: ParseOptions): ParseResult {
  const raw = extractJSON(text)
  if (raw === undefined) {
    return { entries: [], problem: "the model did not answer with JSON" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { entries: [], problem: "the model answered with invalid JSON" }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
      ? ((parsed as { entries: unknown[] }).entries as unknown[])
      : undefined
  if (!list) return { entries: [], problem: 'the JSON has no "entries" array' }

  const entries: DigestEntry[] = []
  let skipped = 0
  for (const item of list) {
    const entry = toDigest(item, options)
    if (entry) entries.push(entry)
    else skipped += 1
  }
  if (entries.length === 0) {
    return { entries: [], problem: `none of the ${list.length} returned entries was usable`, skipped }
  }
  return skipped > 0 ? { entries, skipped } : { entries }
}

function toDigest(item: unknown, options: ParseOptions): DigestEntry | undefined {
  if (!item || typeof item !== "object") return undefined
  const raw = item as Record<string, unknown>
  const text = typeof raw["text"] === "string" ? raw["text"].replace(/\s+/g, " ").trim() : ""
  // A truncated command is worse than a missing one: too long means unusable.
  if (!text || text.length > options.maxTextChars) return undefined
  const tags = Array.isArray(raw["tags"])
    ? raw["tags"]
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, options.maxTags)
    : []
  const key = typeof raw["key"] === "string" ? raw["key"].trim() : ""
  const usable = key && key.length <= MAX_KEY_CHARS && key !== "optional" ? key : undefined
  return { text, tags, ...(usable ? { key: usable } : {}) }
}

/** First `{`/`[` to last `}`/`]`, so fences and surrounding prose do not matter. */
function extractJSON(text: string): string | undefined {
  const body = text.replace(/```[a-zA-Z]*/g, " ").trim()
  const starts = [body.indexOf("{"), body.indexOf("[")].filter((index) => index >= 0)
  if (starts.length === 0) return undefined
  const start = Math.min(...starts)
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"))
  if (end <= start) return undefined
  return body.slice(start, end + 1)
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
