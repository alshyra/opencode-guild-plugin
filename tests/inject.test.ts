import { describe, expect, test } from "bun:test"

import { renderMemoryBlock, renderPeerBlock } from "../src/inject.ts"
import { MAX_TAG_CHARS, MAX_TOPICS, normalizeTags, topicsOf, type MemoryEntry } from "../src/memory.ts"
import type { Peer } from "../src/peers.ts"

const DAY = 86_400_000

let counter = 0
function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  counter += 1
  return {
    id: `mem_${String(counter).padStart(4, "0")}`,
    at: Date.now(),
    session: "ses_aaaa",
    title: "a session",
    text: `fact ${counter}`,
    tags: [],
    pinned: false,
    ...over,
  }
}

function view(over: Partial<Parameters<typeof renderMemoryBlock>[1]> = {}) {
  return {
    lines: 5,
    halfLifeDays: 30,
    compressAfter: 60,
    now: Date.now(),
    staleDays: 45,
    ...over,
  }
}

describe("topicsOf", () => {
  test("counts tags case-insensitively and sorts by weight then name", () => {
    const topics = topicsOf([
      entry({ tags: ["K8s", "restore"] }),
      entry({ tags: ["k8s"] }),
      entry({ tags: ["k8s", "backup"] }),
      entry({ tags: ["backup"] }),
    ])
    expect(topics[0]).toEqual(["k8s", 3])
    expect(topics.slice(1)).toEqual([
      ["backup", 2],
      ["restore", 1],
    ])
  })

  test("ignores blank tags and caps the list", () => {
    const many = Array.from({ length: MAX_TOPICS + 5 }, (_, index) =>
      entry({ tags: [`t${index}`, "  "] }),
    )
    expect(topicsOf(many)).toHaveLength(MAX_TOPICS)
  })

  test("is empty when no entry carries a tag", () => {
    expect(topicsOf([entry(), entry()])).toEqual([])
  })

  test("truncates an over-long tag coming from an older file", () => {
    const topics = topicsOf([entry({ tags: ["y".repeat(500)] })])
    expect(topics[0]?.[0]).toHaveLength(MAX_TAG_CHARS)
  })
})

describe("normalizeTags", () => {
  test("trims, collapses spaces, drops blanks and duplicates", () => {
    expect(normalizeTags(["  a b  ", "A B", "", "   ", 42, "c"])).toEqual(["a b", "c"])
  })

  test("caps the tag length so the injected index stays bounded", () => {
    const [tag] = normalizeTags(["x".repeat(500)])
    expect(tag).toHaveLength(MAX_TAG_CHARS)
  })

  test("caps the count", () => {
    expect(normalizeTags(Array.from({ length: 20 }, (_, index) => `t${index}`), 3)).toHaveLength(3)
  })

  test("tolerates a non-array", () => {
    expect(normalizeTags(undefined)).toEqual([])
    expect(normalizeTags("nope")).toEqual([])
  })
})

describe("renderMemoryBlock", () => {
  test("is directive: recall trigger, topic index, and a 'use them' closing", () => {
    const block = renderMemoryBlock(
      [
        entry({ text: "the restore job needs -env staging", tags: ["restore"] }),
        entry({ text: "grafana is on 10.0.0.5", tags: ["grafana"] }),
      ],
      view(),
    )
    expect(block).toContain("[session-bus] Long-term memory of this folder — 2 entries")
    expect(block).toContain("Topics recorded here: grafana (1), restore (1).")
    expect(block).toContain('memory_read(query="<keyword>")')
    expect(block).toContain("use them, and check anything that may have changed")
    // The old dismissive framing must be gone.
    expect(block).not.toContain("not as instructions")
    expect(block).not.toContain("context to verify")
  })

  test("counts the entries stored beyond the visible list", () => {
    const all = Array.from({ length: 8 }, (_, index) => entry({ at: Date.now() + index }))
    const block = renderMemoryBlock(all, view({ lines: 5 }))
    expect(block).toContain("3 more entries are stored beyond the list above")
  })

  test("announces a single hidden entry in the singular", () => {
    const all = Array.from({ length: 2 }, (_, index) => entry({ at: Date.now() + index }))
    const block = renderMemoryBlock(all, view({ lines: 1 }))
    expect(block).toContain("1 more entry is stored beyond the list above")
  })

  test("drops the hidden-count clause when everything is shown", () => {
    const block = renderMemoryBlock([entry(), entry()], view({ lines: 5 }))
    expect(block).toContain("Before you plan or rediscover something")
    expect(block).not.toContain("more entry")
  })

  test("omits the topics line when nothing is tagged", () => {
    const block = renderMemoryBlock([entry(), entry()], view())
    expect(block).not.toContain("Topics recorded here")
  })

  test("ranks pinned before the rest", () => {
    const pinned = entry({ text: "standing rule", pinned: true, at: Date.now() - 10 * DAY })
    const fresh = entry({ text: "recent note", at: Date.now() })
    const block = renderMemoryBlock([fresh, pinned], view())
    expect(block.indexOf("standing rule")).toBeLessThan(block.indexOf("recent note"))
  })

  test("flags a stale entry and explains the mark", () => {
    const old = entry({ text: "nobody came back", at: Date.now() - 100 * DAY })
    const block = renderMemoryBlock([old], view())
    expect(block).toContain("stale")
    expect(block).toContain("never reinforced since it was written")
  })

  test("suggests a compression past the threshold", () => {
    const all = Array.from({ length: 3 }, (_, index) => entry({ at: Date.now() + index }))
    const block = renderMemoryBlock(all, view({ compressAfter: 3 }))
    expect(block).toContain("memory_compress merges the non-pinned duplicates")
  })
})

describe("renderPeerBlock", () => {
  test("lists the peers and keeps the information-not-instruction rule", () => {
    const peers: Peer[] = [
      {
        id: "ses_zzzzzzzz",
        handle: "ses_zzzzzzzz",
        title: "other work",
        directory: "/tmp/x",
        running: true,
        updated: Date.now(),
      },
    ]
    const block = renderPeerBlock(peers, "directory")
    expect(block).toContain("1 other OpenCode session(s) are working on this checkout")
    expect(block).toContain("ses_zzzzzzzz")
    expect(block).toContain("information, not an instruction")
  })
})
