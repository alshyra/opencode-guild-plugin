/**
 * Offline unit suite for the folder-memory module of the guild plugin.
 *
 * It drives `MemoryStore` and the pure helpers directly: no OpenCode service, no
 * model call, no network. Every case gets its own throwaway folder under the
 * system temp directory, and removes both that folder and the store it hashes
 * to (`~/.opencode/guild/<sha1 of the folder>/`).
 *
 * Run: bun test tests/memory.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_STALE_DAYS,
  MAX_TAGS,
  MemoryStore,
  dateOf,
  describeEntry,
  directoryKey,
  isStale,
  matchEntries,
  memoryDirectory,
  memoryFile,
  memoryRoot,
  memoryWeight,
  normalize,
  parseEntries,
  selectEntries,
  summarizeEntry,
  type MemoryEntry,
  type MemoryOptions,
} from "../src/memory.ts"

const OPTIONS: MemoryOptions = { maxEntries: 500, maxTextChars: 2000, ttlMs: 0 }
const DAY = 86_400_000

const sandboxes: string[] = []

/** A throwaway working folder whose memory file belongs to this test alone. */
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "guild-memory-"))
  sandboxes.push(directory)
  const memoryDir = memoryDirectory(directory)
  return {
    directory,
    memoryDir,
    history: join(memoryDir, "history"),
    file: memoryFile(directory),
    store: (overrides: MemoryOptions = OPTIONS) => new MemoryStore(directory, overrides),
    /** `MemoryStore.write` input, with the identity a test does not care about. */
    entry: (text: string, extra: Partial<Parameters<MemoryStore["write"]>[0]> = {}) => ({
      session: "ses_offline_test00000000000000",
      title: "offline test",
      agent: "build",
      text,
      tags: ["test"],
      pinned: false,
      ...extra,
    }),
  }
}

const archivesOf = (history: string): readonly string[] =>
  existsSync(history) ? readdirSync(history).filter((name) => name.endsWith(".jsonl")) : []

const facts = (...specs: readonly [string, number, number?][]): readonly MemoryEntry[] =>
  specs.map(([text, at, hits], index) => ({
    id: `mem_fact${String(index).padStart(5, "0")}`,
    at,
    session: "ses_offline_test00000000000000",
    title: "offline test",
    text,
    tags: [],
    pinned: false,
    ...(hits ? { hits } : {}),
  }))

afterAll(() => {
  for (const directory of sandboxes) {
    rmSync(memoryDirectory(directory), { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("parseEntries", () => {
  test("keeps the valid lines and ignores blank, torn and invalid ones", () => {
    const raw = [
      '{"id":"mem_bbb","at":2,"session":"s","title":"t","text":"deux","tags":[],"pinned":false}',
      "",
      '{"id":"mem_aaa","at":1,"session":"s","title":"t","text":"un","tags":[],"pinned":false}',
      "   ",
      "{oops",
      "pas du json",
    ].join("\n")
    const entries = parseEntries(raw)
    expect(entries.map((entry) => entry.text)).toEqual(["un", "deux"])
  })

  test("drops an entry without an id or without a text", () => {
    const raw = [
      '{"at":1,"text":"sans id"}',
      '{"id":"mem_vide","text":"   "}',
      '{"id":"mem_ok","text":"gardée"}',
    ].join("\n")
    expect(parseEntries(raw).map((entry) => entry.id)).toEqual(["mem_ok"])
  })

  test("fills the defaults of a minimal line", () => {
    const [entry] = parseEntries('{"id":"mem_min","text":"fait"}')
    expect(entry).toEqual({
      id: "mem_min",
      at: 0,
      session: "unknown",
      title: "(untitled)",
      text: "fait",
      tags: [],
      pinned: false,
    })
  })

  test("keeps the weight, the key and the merge trail", () => {
    const [entry] = parseEntries(
      '{"id":"mem_w","at":5,"session":"s","title":"t","text":"fusion","tags":["a",7],"key":"k","pinned":true,"hits":2,"mergedFrom":["mem_x",4]}',
    )
    expect(entry?.tags).toEqual(["a"])
    expect(entry?.key).toBe("k")
    expect(entry?.pinned).toBe(true)
    expect(entry?.hits).toBe(2)
    expect(entry?.mergedFrom).toEqual(["mem_x"])
  })
})

describe("MemoryStore.write", () => {
  test("appends the first entry and writes it to disk", () => {
    const box = sandbox()
    const result = box.store().write(box.entry("Le port est 49374."))
    expect(result.duplicate).toBe(false)
    expect(result.entry.hits).toBeUndefined()
    expect(result.total).toBe(1)
    expect(box.store().file).toBe(memoryFile(box.directory))
    expect(readFileSync(box.file, "utf8").trim().split("\n")).toHaveLength(1)
  })

  test("writing the same text again counts instead of adding", () => {
    const box = sandbox()
    box.store().write(box.entry("Le port est 49374."))
    const again = box.store().write(box.entry("Le port est 49374."))
    expect(again.duplicate).toBe(true)
    expect(again.entry.hits).toBe(1)
    expect(again.total).toBe(1)
    const third = box.store().write(box.entry("Le port est 49374."))
    expect(third.entry.hits).toBe(2)
  })

  test("the weight round-trips through a fresh store", () => {
    const box = sandbox()
    box.store().write(box.entry("Le port est 49374."))
    box.store().write(box.entry("Le port est 49374."))
    const [reloaded] = new MemoryStore(box.directory, OPTIONS).all()
    expect(reloaded?.hits).toBe(1)
  })

  test("a duplicate is recognized whatever the spacing and the case", () => {
    const box = sandbox()
    box.store().write(box.entry("Le port est 49374."))
    expect(box.store().write(box.entry("  le   PORT est 49374.  ")).duplicate).toBe(true)
  })

  test("a reinforcement writes no archive: nothing was lost", () => {
    const box = sandbox()
    box.store().write(box.entry("Le port est 49374."))
    box.store().write(box.entry("Le port est 49374."))
    expect(archivesOf(box.history)).toHaveLength(0)
  })

  test("a keyed write replaces the entry of that key and inherits its weight", () => {
    const box = sandbox()
    box.store().write(box.entry("Version 1.2.3", { key: "current-release" }))
    const replaced = box.store().write(box.entry("Version 1.2.4", { key: "current-release" }))
    expect(replaced.replaced).toBe(true)
    expect(replaced.total).toBe(1)
    expect(replaced.entry.hits).toBe(1)
    const [onDisk] = new MemoryStore(box.directory, OPTIONS).all()
    expect(onDisk?.text).toBe("Version 1.2.4")
    expect(onDisk?.hits).toBe(1)
  })

  test("past maxEntries the oldest unpinned entries are dropped and the pinned one survives", async () => {
    const box = sandbox()
    const capped = box.store({ maxEntries: 3, maxTextChars: 2000, ttlMs: 0 })
    capped.write(box.entry("le plus ancien"))
    await Bun.sleep(2)
    capped.write(box.entry("la regle permanente", { pinned: true }))
    await Bun.sleep(2)
    capped.write(box.entry("avant dernier"))
    await Bun.sleep(2)
    const last = capped.write(box.entry("le plus recent"))
    expect(last.total).toBe(3)
    expect(last.dropped).toBe(1)
    const texts = capped.all().map((entry) => entry.text)
    expect(texts).not.toContain("le plus ancien")
    expect(texts).toContain("la regle permanente")
    expect(texts).toContain("le plus recent")
    expect(capped.all().filter((entry) => entry.pinned)).toHaveLength(1)
  })
})

describe("MemoryStore.forget", () => {
  test("removes by full id", () => {
    const box = sandbox()
    const { entry } = box.store().write(box.entry("à retirer"))
    box.store().write(box.entry("à garder"))
    const result = box.store().forget(entry.id)
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.removed[0]?.id).toBe(entry.id)
    expect(box.store().all().map((item) => item.text)).toEqual(["à garder"])
  })

  test("removes by id prefix", () => {
    const box = sandbox()
    const { entry } = box.store().write(box.entry("à retirer"))
    const prefix = entry.id.slice(0, 8)
    const result = box.store().forget(prefix)
    expect("error" in result).toBe(false)
    expect(box.store().all()).toHaveLength(0)
  })

  test("removes by key", () => {
    const box = sandbox()
    box.store().write(box.entry("Version 1.2.4", { key: "current-release" }))
    const result = box.store().forget("current-release")
    expect("error" in result).toBe(false)
    expect(box.store().all()).toHaveLength(0)
  })

  test("removes by a unique text fragment", () => {
    const box = sandbox()
    box.store().write(box.entry("le service blast ecoute sur le port 49374"))
    box.store().write(box.entry("la configuration est dans blast.conf"))
    const result = box.store().forget("blast.conf")
    expect("error" in result).toBe(false)
    expect(box.store().all().map((item) => item.text)).toEqual(["le service blast ecoute sur le port 49374"])
  })

  test("refuses an ambiguous fragment", () => {
    const box = sandbox()
    box.store().write(box.entry("le service blast ecoute sur le port 49374"))
    box.store().write(box.entry("le service blast ecoute sur le port 4096"))
    const result = box.store().forget("blast")
    expect("error" in result).toBe(true)
    expect(box.store().all()).toHaveLength(2)
  })

  test("refuses an unknown target", () => {
    const box = sandbox()
    box.store().write(box.entry("un fait"))
    expect("error" in box.store().forget("mem_inexistant")).toBe(true)
    expect(box.store().all()).toHaveLength(1)
  })

  test("archives the previous file before removing", () => {
    const box = sandbox()
    const { entry } = box.store().write(box.entry("à retirer"))
    const before = readFileSync(box.file, "utf8")
    const result = box.store().forget(entry.id)
    const archives = archivesOf(box.history)
    expect(archives).toHaveLength(1)
    expect(readFileSync(join(box.history, archives[0] as string), "utf8")).toBe(before)
    if ("error" in result) throw new Error(result.error)
    expect(result.archive).toBeDefined()
  })
})

describe("MemoryStore.replace", () => {
  test("a dry run reports the change and leaves the file untouched", () => {
    const box = sandbox()
    const first = box.store().write(box.entry("un"))
    box.store().write(box.entry("deux"))
    const before = readFileSync(box.file, "utf8")
    const result = box.store().replace({
      remove: [first.entry.id],
      add: [{ text: "un et deux, fusionnes", tags: ["merged"] }],
      session: "ses_offline_test00000000000000",
      title: "offline test",
      dryRun: true,
    })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.removed).toHaveLength(1)
    expect(result.added).toHaveLength(1)
    expect(result.total).toBe(2)
    expect(readFileSync(box.file, "utf8")).toBe(before)
    expect(archivesOf(box.history)).toHaveLength(0)
  })

  test("writes nothing when a target does not resolve", () => {
    const box = sandbox()
    box.store().write(box.entry("un"))
    const before = readFileSync(box.file, "utf8")
    const result = box.store().replace({
      remove: ["mem_inexistant"],
      add: [{ text: "rien", tags: [] }],
      session: "ses_offline_test00000000000000",
      title: "offline test",
    })
    expect("error" in result).toBe(true)
    expect(readFileSync(box.file, "utf8")).toBe(before)
    expect(archivesOf(box.history)).toHaveLength(0)
  })

  test("removes, adds, links the merge trail and archives the previous file", () => {
    const box = sandbox()
    const one = box.store().write(box.entry("un"))
    const two = box.store().write(box.entry("deux"))
    const before = readFileSync(box.file, "utf8")
    const result = box.store().replace({
      remove: [one.entry.id, two.entry.id],
      add: [{ text: "un et deux, fusionnes", tags: ["merged"] }],
      session: "ses_offline_test00000000000000",
      title: "offline test",
    })
    if ("error" in result) throw new Error(result.error)
    expect(result.removed).toHaveLength(2)
    expect(result.total).toBe(1)
    expect(result.added[0]?.mergedFrom).toEqual([one.entry.id, two.entry.id])
    expect(result.added[0]?.pinned).toBe(false)
    expect(box.store().all().map((item) => item.text)).toEqual(["un et deux, fusionnes"])
    const archives = archivesOf(box.history)
    expect(archives).toHaveLength(1)
    expect(readFileSync(join(box.history, archives[0] as string), "utf8")).toBe(before)
  })

  test("accepts adding without removing", () => {
    const box = sandbox()
    const result = box.store().replace({
      remove: [],
      add: [{ text: "un fait ajoute", tags: [] }],
      session: "ses_offline_test00000000000000",
      title: "offline test",
    })
    if ("error" in result) throw new Error(result.error)
    expect(result.added).toHaveLength(1)
    expect(box.store().all()).toHaveLength(1)
  })
})

describe("MemoryStore.promote", () => {
  test("promotion flips the rule on disk and archives nothing", () => {
    const box = sandbox()
    const { entry } = box.store().write(box.entry("un fait"))
    const result = box.store().promote(entry.id, true)
    if ("error" in result) throw new Error(result.error)
    expect(result.changed).toBe(true)
    expect(result.archive).toBeUndefined()
    expect(archivesOf(box.history)).toHaveLength(0)
    expect(box.store().all()[0]?.pinned).toBe(true)
  })

  test("promoting twice changes nothing", () => {
    const box = sandbox()
    const { entry } = box.store().write(box.entry("un fait"))
    box.store().promote(entry.id, true)
    const again = box.store().promote(entry.id, true)
    if ("error" in again) throw new Error(again.error)
    expect(again.changed).toBe(false)
    expect(archivesOf(box.history)).toHaveLength(0)
  })

  test("demotion archives: it is the direction that loses a protection", () => {
    const box = sandbox()
    const { entry } = box.store().write(box.entry("un fait", { pinned: true }))
    const result = box.store().promote(entry.id, false)
    if ("error" in result) throw new Error(result.error)
    expect(result.changed).toBe(true)
    expect(result.archive).toBeDefined()
    expect(archivesOf(box.history)).toHaveLength(1)
    expect(box.store().all()[0]?.pinned).toBe(false)
  })

  test("refuses an unknown target", () => {
    const box = sandbox()
    expect("error" in box.store().promote("mem_inexistant", true)).toBe(true)
  })
})

describe("memoryWeight", () => {
  const NOW = 1_800_000_000_000
  const [fresh, oneHalfLife, twoHalfLives, noHits] = facts(
    ["frais", 0, 3],
    ["une demi-vie", 0, 3],
    ["deux demi-vies", 0, 3],
    ["jamais renforce", 0],
  )

  test("a fresh fact keeps its whole weight", () => {
    expect(memoryWeight({ ...fresh, at: NOW } as MemoryEntry, NOW, 30)).toBe(3)
  })

  test("the weight is halved every half-life", () => {
    expect(memoryWeight({ ...oneHalfLife, at: NOW - 30 * DAY } as MemoryEntry, NOW, 30)).toBeCloseTo(1.5, 6)
    expect(memoryWeight({ ...twoHalfLives, at: NOW - 60 * DAY } as MemoryEntry, NOW, 30)).toBeCloseTo(0.75, 6)
  })

  test("halfLifeDays: 0 returns the raw weight", () => {
    expect(memoryWeight({ ...fresh, at: NOW - 365 * DAY } as MemoryEntry, NOW, 0)).toBe(3)
  })

  test("a fact without a hit weighs nothing, whatever its age", () => {
    expect(memoryWeight({ ...noHits, at: NOW - 365 * DAY } as MemoryEntry, NOW, 30)).toBe(0)
  })

  test("a merge counts in the weight", () => {
    expect(memoryWeight({ ...fresh, at: NOW, mergedFrom: ["mem_a", "mem_b"] } as MemoryEntry, NOW, 30)).toBe(5)
  })

  test("the default half-life is the documented one", () => {
    expect(DEFAULT_HALF_LIFE_DAYS).toBe(30)
    expect(DEFAULT_STALE_DAYS).toBe(45)
  })
})

describe("isStale", () => {
  const NOW = 1_800_000_000_000
  const old = facts(["une note jamais relue", 0])[0] as MemoryEntry

  test("an old note nobody reinforced is stale", () => {
    expect(isStale({ ...old, at: NOW - 46 * DAY }, NOW, 45)).toBe(true)
  })

  test("a recent note is not stale", () => {
    expect(isStale({ ...old, at: NOW - 44 * DAY }, NOW, 45)).toBe(false)
  })

  test("a pinned entry is never stale", () => {
    expect(isStale({ ...old, at: NOW - 365 * DAY, pinned: true }, NOW, 45)).toBe(false)
  })

  test("a reinforced entry is never stale", () => {
    expect(isStale({ ...old, at: NOW - 365 * DAY, hits: 2 }, NOW, 45)).toBe(false)
  })

  test("staleDays: 0 turns the notion off", () => {
    expect(isStale({ ...old, at: NOW - 3650 * DAY }, NOW, 0)).toBe(false)
  })
})

describe("selectEntries", () => {
  const NOW = 1_800_000_000_000

  test("orders pinned first, then the decayed weight, then recency", () => {
    const pool = [
      { ...facts(["vieux renforce", 0, 3])[0], at: NOW - 100 * DAY },
      { ...facts(["frais renforce", 0, 1])[0], at: NOW - 1 * DAY },
      { ...facts(["jamais renforce", 0])[0], at: NOW - 2 * DAY },
      { ...facts(["regle", 0, 5])[0], at: NOW - 200 * DAY, pinned: true },
    ] as readonly MemoryEntry[]
    const ordered = selectEntries(pool, undefined, [], 4, { now: NOW, halfLifeDays: 30 })
    expect(ordered.map((entry) => entry.text)).toEqual([
      "regle",
      "frais renforce",
      "vieux renforce",
      "jamais renforce",
    ])
  })

  test("without decay the raw weight wins", () => {
    const pool = [
      { ...facts(["vieux renforce", 0, 3])[0], at: NOW - 100 * DAY },
      { ...facts(["frais renforce", 0, 1])[0], at: NOW - 1 * DAY },
      { ...facts(["regle", 0, 5])[0], at: NOW - 200 * DAY, pinned: true },
    ] as readonly MemoryEntry[]
    const ordered = selectEntries(pool, undefined, [], 3, { now: NOW, halfLifeDays: 0 })
    expect(ordered.map((entry) => entry.text)).toEqual(["regle", "vieux renforce", "frais renforce"])
  })

  test("the limit keeps the strongest", () => {
    const pool = [
      { ...facts(["discret", 0])[0], at: NOW },
      { ...facts(["regle", 0, 5])[0], at: 0, pinned: true },
    ] as readonly MemoryEntry[]
    expect(selectEntries(pool, undefined, [], 1, { now: NOW }).map((entry) => entry.text)).toEqual(["regle"])
  })

  test("filters by text and by tags", () => {
    const pool = [
      { ...facts(["le port du service blast", 0])[0], tags: ["blast", "port"] },
      { ...facts(["la configuration du portal", 0])[0], tags: ["portal"] },
    ] as readonly MemoryEntry[]
    expect(selectEntries(pool, "blast", [], 5).map((entry) => entry.text)).toEqual(["le port du service blast"])
    expect(selectEntries(pool, undefined, ["portal"], 5).map((entry) => entry.text)).toEqual([
      "la configuration du portal",
    ])
    expect(selectEntries(pool, "blast", ["portal"], 5)).toHaveLength(0)
  })
})

describe("formatting and helpers", () => {
  const entry: MemoryEntry = {
    id: "mem_mark0000",
    at: Date.UTC(2026, 9, 16),
    session: "ses_offline_test00000000000000",
    title: "offline test",
    text: "un fait renforce",
    tags: ["test"],
    pinned: false,
    hits: 3,
  }

  test("describes an entry with its weight, its tags and its origin", () => {
    const line = describeEntry(entry, 60)
    expect(line).toContain("mem_mark0000")
    expect(line).toContain("×3")
    expect(line).toContain("2026-10-16")
    expect(line).toContain("(tags: test)")
  })

  test("marks a stale entry, in the description and in the injected line", () => {
    const now = Date.UTC(2027, 9, 16)
    const stale: MemoryEntry = { ...entry, hits: undefined }
    expect(describeEntry(stale, 60, now, 45)).toContain("stale")
    expect(summarizeEntry(stale, 160, now, 45)).toContain("- stale")
    expect(summarizeEntry(entry, 160, now, 45)).not.toContain("stale")
  })

  test("staleDays: 0 removes the mark", () => {
    const now = Date.UTC(2027, 9, 16)
    expect(summarizeEntry({ ...entry, hits: undefined }, 160, now, 0)).not.toContain("stale")
  })

  test("matchEntries resolves ids, prefixes, keys and fragments", () => {
    const pool: readonly MemoryEntry[] = [
      { ...entry, id: "mem_alpha00001", text: "le port est 49374", key: "blast-port" },
      { ...entry, id: "mem_beta000002", text: "la configuration est ailleurs" },
    ]
    expect(matchEntries(pool, "mem_alpha00001")).toHaveLength(1)
    expect(matchEntries(pool, "mem_alpha")[0]?.id).toBe("mem_alpha00001")
    expect(matchEntries(pool, "blast-port")[0]?.id).toBe("mem_alpha00001")
    expect(matchEntries(pool, "configuration")[0]?.id).toBe("mem_beta000002")
    expect(matchEntries(pool, "mem_absent")).toHaveLength(0)
  })

  test("dateOf and normalize are the documented ones", () => {
    expect(dateOf(Date.UTC(2026, 9, 16))).toBe("2026-10-16")
    expect(normalize("  Le   Port  ")).toBe("le port")
  })

  test("MAX_TAGS caps what a caller may attach", () => {
    expect(MAX_TAGS).toBe(8)
  })

  test("the store lives outside the working folder, keyed by its path", () => {
    const first = "/workspace/offline-a"
    const second = "/workspace/offline-b"
    expect(directoryKey(first)).toBe(directoryKey(first))
    expect(directoryKey(first)).not.toBe(directoryKey(second))
    expect(directoryKey(first)).toMatch(/^[0-9a-f]{40}$/)
    expect(memoryRoot()).toEndWith(join(".opencode", "guild"))
    expect(memoryDirectory(first)).toBe(join(memoryRoot(), directoryKey(first)))
    expect(memoryFile(first)).toBe(join(memoryDirectory(first), "memory.jsonl"))
  })
})
