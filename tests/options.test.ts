/**
 * Offline unit suite for the option parsing (the pure `resolveOptions`).
 *
 * No service, no disk: every field falls back to `defaultOptions` unless the
 * caller passes a usable value, and 0 is a real value for the memory switches.
 *
 * Run: bun test tests/options.test.ts
 */
import { describe, expect, test } from "bun:test"

import { defaultOptions, resolveOptions } from "../src/options.ts"

describe("resolveOptions", () => {
  test("an empty input yields the documented defaults", () => {
    expect(resolveOptions({})).toEqual(defaultOptions)
    const options = resolveOptions({})
    expect(options.memoryHalfLifeDays).toBe(30)
    expect(options.memoryStaleDays).toBe(45)
    expect(options.memoryPromoteAfter).toBe(3)
  })

  test("the sidebar can hide the peer list without touching the peer tools", () => {
    expect(resolveOptions({}).tuiPeers).toBe(true)
    expect(resolveOptions({ tuiPeers: false }).tuiPeers).toBe(false)
    expect(resolveOptions({ tuiPeers: false }).injectPeers).toBe(true)
  })

  test("0 is a meaningful value for the memory switches", () => {
    const options = resolveOptions({ memoryHalfLifeDays: 0, memoryStaleDays: 0, memoryCompressAfter: 0 })
    expect(options.memoryHalfLifeDays).toBe(0)
    expect(options.memoryStaleDays).toBe(0)
    expect(options.memoryCompressAfter).toBe(0)
  })

  test("a valid value is kept, an unusable one falls back", () => {
    const options = resolveOptions({ memoryHalfLifeDays: 7, memoryStaleDays: "nope", memoryMaxEntries: -3 })
    expect(options.memoryHalfLifeDays).toBe(7)
    expect(options.memoryStaleDays).toBe(defaultOptions.memoryStaleDays)
    expect(options.memoryMaxEntries).toBe(defaultOptions.memoryMaxEntries)
  })

  test("enums and booleans fall back on anything unknown", () => {
    const options = resolveOptions({ permission: "maybe", scope: "galaxy", delivery: 1, memory: "yes" })
    expect(options.permission).toBe(defaultOptions.permission)
    expect(options.scope).toBe(defaultOptions.scope)
    expect(options.delivery).toBe(defaultOptions.delivery)
    expect(options.memory).toBe(defaultOptions.memory)
  })

  test("a positive-only field rejects 0 and negatives", () => {
    const options = resolveOptions({ maxPeers: 0, maxMessagesPerMinute: -2, memoryInjectLines: 0 })
    expect(options.maxPeers).toBe(defaultOptions.maxPeers)
    expect(options.maxMessagesPerMinute).toBe(defaultOptions.maxMessagesPerMinute)
    expect(options.memoryInjectLines).toBe(defaultOptions.memoryInjectLines)
  })
})
