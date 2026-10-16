/**
 * Offline unit suite for the folder-memory compression (`src/compress.ts`).
 *
 * It drives the two pure functions (`buildCompressionPrompt`, `parseCompression`)
 * and `compressMemory` against a stub model: no OpenCode service, no network, no
 * real model call. Every case gets its own throwaway folder, removed afterwards.
 *
 * Run: bun test tests/compress.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildCompressionPrompt,
  compressMemory,
  parseCompression,
  type CompressDeps,
  type DigestEntry,
} from "../src/compress.ts"
import { MemoryStore, memoryDirectory, memoryFile, type MemoryEntry } from "../src/memory.ts"
import { defaultOptions } from "../src/options.ts"

const MAX_TEXT = 120
const MAX_TAGS = 3
const PARSE = { maxTextChars: MAX_TEXT, maxTags: MAX_TAGS }

const sandboxes: string[] = []

/** A throwaway working folder whose memory file belongs to this test alone. */
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "guild-compress-"))
  sandboxes.push(directory)
  const memoryDir = memoryDirectory(directory)
  return {
    directory,
    memoryDir,
    history: join(memoryDir, "history"),
    file: memoryFile(directory),
    store: (overrides = { maxEntries: 50, maxTextChars: 300, ttlMs: 0 }) =>
      new MemoryStore(directory, overrides),
  }
}

const archivesOf = (history: string): readonly string[] =>
  existsSync(history) ? readdirSync(history).filter((name) => name.endsWith(".jsonl")) : []

afterAll(() => {
  for (const directory of sandboxes) {
    rmSync(memoryDirectory(directory), { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A `compressMemory` harness whose model answers `answer` (or throws it). */
function harness(answer: string | Error) {
  const box = sandbox()
  const state = { calls: 0 }
  const ctx = {
    generate: {
      text: async () => {
        state.calls += 1
        if (answer instanceof Error) throw answer
        return { text: answer }
      },
    },
  }
  const memory = box.store()
  const deps = { ctx, memory, options: { ...defaultOptions, memoryMaxChars: 300 } } as unknown as CompressDeps
  const caller = { sessionID: "ses_offline_test00000000000000", title: "offline test" }
  const seed = (...specs: readonly [string, boolean?][]) => {
    for (const [text, pinned] of specs) {
      memory.write({
        session: caller.sessionID,
        title: caller.title,
        text,
        tags: [],
        pinned: pinned === true,
      })
    }
  }
  const lines = () => readFileSync(box.file, "utf8").split("\n").filter(Boolean).length
  return { box, memory, deps, caller, seed, lines, calls: () => state.calls }
}

const threeAndOne = (seed: (...specs: readonly [string, boolean?][]) => void) => {
  seed(["un"], ["deux"], ["trois"], ["regle permanente", true])
}

const entry = (text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: `mem_${text.slice(0, 6).padEnd(6, "0")}`,
  at: 1_800_000_000_000,
  session: "ses_offline_test00000000000000",
  title: "offline test",
  text,
  tags: [],
  pinned: false,
  ...extra,
})

const json = (value: unknown) => JSON.stringify(value)

describe("parseCompression", () => {
  test("reads a clean payload and keeps text and tags", () => {
    const result = parseCompression(json({ entries: [{ text: "alpha", tags: ["a", "b"] }] }), PARSE)
    expect(result.problem).toBeUndefined()
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.text).toBe("alpha")
    expect(result.entries[0]?.tags).toEqual(["a", "b"])
  })

  test("tolerates a code fence and surrounding prose", () => {
    const fenced = `Voici le résultat.\n\`\`\`json\n${json({ entries: [{ text: "fence", tags: [] }] })}\n\`\`\`\nVoilà.`
    const prose = `Analyse terminée.\nJe propose :\n${json({ entries: [{ text: "prose", tags: [] }] })}\nFin.`
    expect(parseCompression(fenced, PARSE).entries[0]?.text).toBe("fence")
    expect(parseCompression(prose, PARSE).entries[0]?.text).toBe("prose")
  })

  test("accepts a bare array as well as the entries wrapper", () => {
    const bare = parseCompression(json([{ text: "bare", tags: [] }]), PARSE)
    expect(bare.entries).toHaveLength(1)
    expect(bare.entries[0]?.text).toBe("bare")
  })

  test("drops the entries without a usable text and counts them", () => {
    const payload = json({
      entries: [{ text: "keep", tags: ["x"] }, { tags: ["orphan"] }, { text: "   ", tags: [] }, null, "no"],
    })
    const result = parseCompression(payload, PARSE)
    expect(result.entries.map((item) => item.text)).toEqual(["keep"])
    expect(result.skipped).toBe(4)
  })

  test("drops an over-long text rather than truncating it", () => {
    const long = "y".repeat(MAX_TEXT * 3)
    const only = parseCompression(json({ entries: [{ text: long, tags: [] }] }), PARSE)
    expect(only.entries).toHaveLength(0)
    expect(only.problem).toBeString()
    expect(only.skipped).toBe(1)

    const mixed = parseCompression(
      json({ entries: [{ text: "short enough", tags: [] }, { text: "z".repeat(MAX_TEXT + 1), tags: [] }] }),
      PARSE,
    )
    expect(mixed.entries.map((item) => item.text)).toEqual(["short enough"])
    expect(mixed.problem).toBeUndefined()
    expect(mixed.skipped).toBe(1)
  })

  test("caps the tags at maxTags, keeping the first ones in order", () => {
    const entry = parseCompression(json({ entries: [{ text: "many", tags: ["a", "b", "c", "d", "e"] }] }), PARSE)
      .entries[0] as DigestEntry
    expect(entry.tags).toEqual(["a", "b", "c"])
  })

  test("keeps a real key, ignores the placeholder the prompt shows", () => {
    expect(
      parseCompression(json({ entries: [{ text: "no key", tags: [] }] }), PARSE).entries[0]?.key,
    ).toBeUndefined()
    expect(
      parseCompression(json({ entries: [{ text: "keyed", tags: [], key: "current-release" }] }), PARSE).entries[0]?.key,
    ).toBe("current-release")
    expect(
      parseCompression(json({ entries: [{ text: "d", key: "optional" }] }), PARSE).entries[0]?.key,
    ).toBeUndefined()
  })

  test("reports a problem on every unusable answer", () => {
    const unwanted = [
      "",
      "   \n  ",
      "Je ne peux pas répondre.",
      '{"entries":[{"text":"a"',
      json({ result: "nothing" }),
    ]
    for (const text of unwanted) {
      const result = parseCompression(text, PARSE)
      expect(result.entries).toHaveLength(0)
      expect(result.problem).toBeString()
    }
  })
})

describe("buildCompressionPrompt", () => {
  const entries = [
    entry("le service blast écoute sur le port 49374", { tags: ["blast", "port"] }),
    entry("les journaux vivent dans /var/log/blast", { tags: ["logs"] }),
    entry("règle: ne pas redémarrer blast le vendredi", { tags: ["règle"], pinned: true }),
  ]

  test("carries every entry id and text, and asks for JSON entries", () => {
    const prompt = buildCompressionPrompt(entries)
    for (const item of entries) {
      expect(prompt).toContain(item.id)
      expect(prompt).toContain(item.text)
    }
    expect(prompt).toMatch(/json/i)
    expect(prompt).toMatch(/entries/i)
  })

  test("is deterministic and forwards the extra note", () => {
    expect(buildCompressionPrompt(entries)).toBe(buildCompressionPrompt(entries))
    const note = "Ces entrées parlent toutes du service blast."
    expect(buildCompressionPrompt(entries, note)).toContain(note)
    expect(buildCompressionPrompt(entries, note)).toBe(buildCompressionPrompt(entries, note))
  })

  test("still builds a prompt for an empty batch", () => {
    expect(buildCompressionPrompt([]).length).toBeGreaterThan(0)
  })
})

describe("compressMemory", () => {
  test("refuses without calling the model when there is nothing to merge", async () => {
    const run = harness("{}")
    run.seed(["seule", true])
    const report = await compressMemory(run.deps, { caller: run.caller, dryRun: false })
    expect(report.applied).toBe(false)
    expect(report.problem).toContain("nothing to compress")
    expect(run.calls()).toBe(0)
  })

  test("writes nothing when the model call fails", async () => {
    const run = harness(new Error("provider down"))
    threeAndOne(run.seed)
    const report = await compressMemory(run.deps, { caller: run.caller, dryRun: false })
    expect(report.applied).toBe(false)
    expect(report.problem).toBeString()
    expect(run.lines()).toBe(4)
    expect(archivesOf(run.box.history)).toHaveLength(0)
    expect(run.memory.all()).toHaveLength(4)
  })

  test("writes nothing when the answer holds no JSON", async () => {
    const run = harness("je ne sais pas quoi dire")
    threeAndOne(run.seed)
    const report = await compressMemory(run.deps, { caller: run.caller, dryRun: false })
    expect(report.applied).toBe(false)
    expect(report.problem).toBeString()
    expect(run.lines()).toBe(4)
  })

  test("refuses a merge that gains nothing", async () => {
    const run = harness(json({ entries: [{ text: "a" }, { text: "b" }, { text: "c" }] }))
    threeAndOne(run.seed)
    const report = await compressMemory(run.deps, { caller: run.caller, dryRun: false })
    expect(report.applied).toBe(false)
    expect(report.problem).toContain("gain")
    expect(run.lines()).toBe(4)
  })

  test("applies a merge, leaving the pinned entry untouched and archiving first", async () => {
    const run = harness(json({ entries: [{ text: "un, deux et trois en une phrase", tags: ["merged"] }] }))
    threeAndOne(run.seed)
    const report = await compressMemory(run.deps, { caller: run.caller, dryRun: false })
    expect(report.applied).toBe(true)
    expect(report.before).toBe(4)
    expect(report.after).toBe(2)
    expect(report.pool).toBe(3)
    expect(run.lines()).toBe(2)
    expect(run.memory.all().some((item) => item.pinned && item.text === "regle permanente")).toBe(true)
    expect(archivesOf(run.box.history)).toHaveLength(1)
    const merged = run.memory.all().find((item) => item.text.startsWith("un, deux"))
    expect(merged?.mergedFrom).toHaveLength(3)
    expect(merged?.pinned).toBe(false)
    expect(merged?.tags).toEqual(["merged"])
  })

  test("a dry run reports the merge and touches nothing", async () => {
    const run = harness(json({ entries: [{ text: "fusion" }] }))
    threeAndOne(run.seed)
    const report = await compressMemory(run.deps, { caller: run.caller, dryRun: true })
    expect(report.applied).toBe(false)
    expect(report.after).toBe(2)
    expect(run.lines()).toBe(4)
    expect(archivesOf(run.box.history)).toHaveLength(0)
    expect(run.memory.all()).toHaveLength(4)
  })

  test("reports the keys the merge dropped", async () => {
    const run = harness(json({ entries: [{ text: "fusion sans cle" }] }))
    run.seed(["valeur A"], ["valeur B"])
    // Give both entries a key through a keyed write, the only way keys enter.
    run.memory.write({ session: run.caller.sessionID, title: run.caller.title, text: "A", tags: [], key: "cle-a", pinned: false })
    run.memory.write({ session: run.caller.sessionID, title: run.caller.title, text: "B", tags: [], key: "cle-b", pinned: false })
    const report = await compressMemory(run.deps, { caller: run.caller, dryRun: true })
    expect(report.lostKeys.sort()).toEqual(["cle-a", "cle-b"])
  })

  test("counts the unusable entries and keeps the rest", async () => {
    const run = harness(json({ entries: [{ text: "garde" }, { text: "" }, { tags: ["x"] }] }))
    threeAndOne(run.seed)
    const report = await compressMemory(run.deps, { caller: run.caller, dryRun: true })
    expect(report.skipped).toBe(2)
    expect(report.entries).toHaveLength(1)
    expect(report.after).toBe(2)
  })
})
