import { describe, expect, test } from "bun:test"

import { MARKER, isPeerMessage, renderPeerMessage, stripPeerEnvelope, type PeerMessageMeta } from "../src/envelope.ts"
import {
  activityLine,
  countPeerMessages,
  describePeer,
  handleOf,
  isSessionID,
  isToolRunning,
  lastToolUse,
  selectPeers,
  toPeer,
  toolHint,
  type Peer,
  type PeerSelection,
  type SessionLike,
  type SessionMessageLike,
} from "../src/peers.ts"

/** Everything is time-relative: an injected clock keeps these tests deterministic. */
const NOW = 1_800_000_000_000
const MINUTE = 60_000
const DAY = 86_400_000

const session = (overrides: Partial<SessionLike> & { id: string }): SessionLike => ({
  time: { created: NOW - DAY, updated: NOW },
  location: { directory: "/work" },
  ...overrides,
})

const selection = (overrides: Partial<PeerSelection> = {}): PeerSelection => ({
  scope: "directory",
  directory: "/work",
  includeIdle: false,
  idleWindowMs: 15 * MINUTE,
  maxPeers: 10,
  running: new Set<string>(),
  now: NOW,
  ...overrides,
})

const assistant = (parts: SessionMessageLike["content"], created: number): SessionMessageLike => ({
  type: "assistant",
  time: { created },
  content: parts,
})

const tool = (name: string, status: string, input?: unknown) => ({
  type: "tool",
  name,
  state: { status, ...(input === undefined ? {} : { input }) },
})

const peer = (overrides: Partial<Peer> & { id: string }): Peer => ({
  handle: handleOf(overrides.id),
  title: "A session",
  directory: "/work",
  running: false,
  updated: NOW,
  ...overrides,
})

const meta = (overrides: Partial<PeerMessageMeta> = {}): PeerMessageMeta => ({
  bus: "session-bus",
  v: 1,
  from: "ses_aaaaaaaaaabbbbbbbbbb",
  fromTitle: "Session A",
  fromDirectory: "/work",
  kind: "note",
  hop: 0,
  ts: NOW,
  ...overrides,
})

describe("handleOf / isSessionID", () => {
  test("handleOf keeps the first 14 characters", () => {
    expect(handleOf("ses_abcdefghijklmnop")).toBe("ses_abcdefghij")
    expect(handleOf("ses_ebbd7efb4ffe0erb1JkNPD15W8")).toBe("ses_ebbd7efb4f")
  })

  test("handleOf returns short ids unchanged", () => {
    expect(handleOf("ses_short")).toBe("ses_short")
  })

  test("isSessionID accepts ses_ ids only", () => {
    expect(isSessionID("ses_0123456789")).toBe(true)
    expect(isSessionID("mem_0123456789")).toBe(false)
    expect(isSessionID("ses")).toBe(false)
    expect(isSessionID(undefined)).toBe(false)
    expect(isSessionID(42)).toBe(false)
  })
})

describe("toPeer", () => {
  test("maps a session to a peer", () => {
    const result = toPeer(
      session({
        id: "ses_0123456789abcdef",
        title: "  Plan de fiabilisation  ",
        agent: "build",
        projectID: "project-1",
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
        time: { created: NOW - DAY, updated: NOW - MINUTE },
        location: { directory: "/work/avd" },
      }),
      true,
    )

    expect(result).toEqual({
      id: "ses_0123456789abcdef",
      handle: "ses_0123456789",
      title: "Plan de fiabilisation",
      agent: "build",
      model: "anthropic/claude-sonnet-4-5",
      directory: "/work/avd",
      projectID: "project-1",
      running: true,
      updated: NOW - MINUTE,
    })
  })

  test("falls back to (untitled) when the title is missing or blank", () => {
    expect(toPeer(session({ id: "ses_a" }), false).title).toBe("(untitled)")
    expect(toPeer(session({ id: "ses_b", title: "   " }), false).title).toBe("(untitled)")
  })

  test("builds the model string from what is available", () => {
    expect(toPeer(session({ id: "ses_a" }), false).model).toBeUndefined()
    expect(toPeer(session({ id: "ses_b", model: {} }), false).model).toBeUndefined()
    expect(toPeer(session({ id: "ses_c", model: { providerID: "acme" } }), false).model).toBe("acme")
    expect(toPeer(session({ id: "ses_d", model: { id: "reasoner" } }), false).model).toBe("reasoner")
  })

  test("tolerates a payload without a location or a date", () => {
    const partial = { id: "ses_partial" } as unknown as SessionLike
    const result = toPeer(partial, false)
    expect(result.directory).toBe("")
    expect(result.updated).toBe(0)
  })
})

describe("selectPeers", () => {
  test("excludes the caller", () => {
    const peers = selectPeers(
      [session({ id: "ses_self" }), session({ id: "ses_other" })],
      selection({ self: "ses_self" }),
    )
    expect(peers.map((item) => item.id)).toEqual(["ses_other"])
  })

  test("excludes subagent sessions and archived ones", () => {
    const peers = selectPeers(
      [
        session({ id: "ses_root" }),
        session({ id: "ses_child", parentID: "ses_root" }),
        session({ id: "ses_archived", time: { created: NOW - DAY, updated: NOW, archived: NOW } }),
      ],
      selection(),
    )
    expect(peers.map((item) => item.id)).toEqual(["ses_root"])
  })

  test("directory scope keeps one directory, project scope keeps them all", () => {
    const sessions = [
      session({ id: "ses_here", location: { directory: "/work" } }),
      session({ id: "ses_worktree", location: { directory: "/work-wt" } }),
    ]
    expect(selectPeers(sessions, selection({ scope: "directory" })).map((item) => item.id)).toEqual(["ses_here"])
    expect(selectPeers(sessions, selection({ scope: "project" })).map((item) => item.id)).toEqual([
      "ses_here",
      "ses_worktree",
    ])
  })

  test("drops sessions idle for longer than the window, unless includeIdle", () => {
    const sessions = [
      session({ id: "ses_fresh", time: { created: NOW - DAY, updated: NOW - MINUTE } }),
      session({ id: "ses_idle", time: { created: NOW - DAY, updated: NOW - 30 * MINUTE } }),
    ]
    expect(selectPeers(sessions, selection()).map((item) => item.id)).toEqual(["ses_fresh"])
    expect(selectPeers(sessions, selection({ includeIdle: true })).map((item) => item.id)).toEqual([
      "ses_fresh",
      "ses_idle",
    ])
  })

  test("keeps a running session however old it is", () => {
    const sessions = [session({ id: "ses_running", time: { created: NOW - 10 * DAY, updated: NOW - 10 * DAY } })]
    const peers = selectPeers(sessions, selection({ running: new Set(["ses_running"]) }))
    expect(peers).toHaveLength(1)
    expect(peers[0]?.running).toBe(true)
  })

  test("orders running sessions first, then the most recent", () => {
    const sessions = [
      session({ id: "ses_old", time: { created: NOW - DAY, updated: NOW - 10 * MINUTE } }),
      session({ id: "ses_recent", time: { created: NOW - DAY, updated: NOW - MINUTE } }),
      session({ id: "ses_running", time: { created: NOW - DAY, updated: NOW - 5 * MINUTE } }),
    ]
    const peers = selectPeers(sessions, selection({ running: new Set(["ses_running"]) }))
    expect(peers.map((item) => item.id)).toEqual(["ses_running", "ses_recent", "ses_old"])
  })

  test("slices to maxPeers after ordering", () => {
    const sessions = [1, 2, 3].map((index) =>
      session({ id: `ses_${index}`, time: { created: NOW - DAY, updated: NOW - index * MINUTE } }),
    )
    expect(selectPeers(sessions, selection({ maxPeers: 2 })).map((item) => item.id)).toEqual(["ses_1", "ses_2"])
  })

  test("applies the idle window against the injected clock", () => {
    const sessions = [session({ id: "ses_x", time: { created: NOW - DAY, updated: NOW - 20 * MINUTE } })]
    expect(selectPeers(sessions, selection({ now: NOW })).map((item) => item.id)).toEqual([])
    expect(selectPeers(sessions, selection({ now: NOW + 10 * MINUTE })).map((item) => item.id)).toEqual([])
    expect(selectPeers(sessions, selection({ now: NOW - 10 * MINUTE })).map((item) => item.id)).toEqual(["ses_x"])
  })
})

describe("describePeer", () => {
  test("describes a running peer", () => {
    expect(describePeer(peer({ id: "ses_running", title: "Build", agent: "build", running: true }), NOW)).toBe(
      'ses_running "Build", agent build, working now',
    )
  })

  test("describes an idle peer with its age, and drops the agent when absent", () => {
    expect(describePeer(peer({ id: "ses_idle", title: "Plan", updated: NOW - 5 * MINUTE }), NOW)).toBe(
      'ses_idle "Plan", idle, seen 5m ago',
    )
  })

  test("truncates a long title", () => {
    const described = describePeer(peer({ id: "ses_long", title: "x".repeat(90) }), NOW)
    expect(described).toContain("…")
    expect(described).toContain("x".repeat(69))
  })
})

describe("lastToolUse / isToolRunning", () => {
  test("returns the last tool of the last assistant message, whatever the message order", () => {
    const messages: SessionMessageLike[] = [
      assistant([tool("edit", "completed", { filePath: "later.ts" })], NOW),
      assistant([tool("read", "completed", { path: "early.ts" })], NOW - MINUTE),
    ]
    expect(lastToolUse(messages)).toEqual({ name: "edit", status: "completed", hint: "later.ts" })
  })

  test("walks the parts of one message in order", () => {
    const messages: SessionMessageLike[] = [
      assistant(
        [
          { type: "text", text: "je regarde" },
          tool("grep", "completed", { pattern: "port" }),
          tool("shell", "running", { command: "npm test" }),
        ],
        NOW,
      ),
    ]
    expect(lastToolUse(messages)).toEqual({ name: "shell", status: "running", hint: "npm test" })
  })

  test("ignores non-tool parts and nameless ones, and returns undefined without a tool", () => {
    expect(lastToolUse([assistant([{ type: "text", text: "bonjour" }], NOW)])).toBeUndefined()
    expect(lastToolUse([assistant([{ type: "tool", state: { status: "completed" } }], NOW)])).toBeUndefined()
    expect(lastToolUse([])).toBeUndefined()
    expect(lastToolUse([{ type: "user", time: { created: NOW }, text: "salut" }])).toBeUndefined()
  })

  test("omits the hint when no field is usable", () => {
    expect(lastToolUse([assistant([tool("read", "completed", { unknown: 1 })], NOW)])).toEqual({
      name: "read",
      status: "completed",
    })
  })

  test("defaults the status to unknown", () => {
    expect(lastToolUse([assistant([{ type: "tool", name: "read", state: {} }], NOW)])).toEqual({
      name: "read",
      status: "unknown",
    })
  })

  test("isToolRunning only accepts running and streaming", () => {
    expect(isToolRunning("running")).toBe(true)
    expect(isToolRunning("streaming")).toBe(true)
    expect(isToolRunning("completed")).toBe(false)
    expect(isToolRunning("error")).toBe(false)
    expect(isToolRunning("unknown")).toBe(false)
  })
})

describe("activityLine", () => {
  const runningTool = { name: "shell", status: "running", hint: "npm test" }

  test("announces the work in flight", () => {
    expect(activityLine(runningTool, true)).toBe("running: shell npm test")
    expect(activityLine(runningTool, false)).toBe("running: shell npm test")
  })

  test("labels a finished tool as past only while the peer works", () => {
    expect(activityLine({ name: "edit", status: "completed", hint: "src/x.ts" }, true)).toBe("last: edit src/x.ts")
    expect(activityLine({ name: "edit", status: "completed", hint: "src/x.ts" }, false)).toBeUndefined()
  })

  test("marks a failure and survives a missing hint", () => {
    expect(activityLine({ name: "shell", status: "error", hint: "npm test" }, true)).toBe(
      "last: shell npm test (failed)",
    )
    expect(activityLine({ name: "read", status: "completed" }, true)).toBe("last: read")
  })

  test("says nothing without a tool", () => {
    expect(activityLine(undefined, true)).toBeUndefined()
    expect(activityLine(undefined, false)).toBeUndefined()
  })
})

describe("countPeerMessages", () => {
  const message = (kind: string | undefined, from: string | undefined, created: number): SessionMessageLike => ({
    type: kind,
    time: { created },
    metadata: from ? { from } : {},
  })

  test("counts only that peer's synthetic messages after the given date", () => {
    const messages: SessionMessageLike[] = [
      message("synthetic", "ses_a", NOW),
      message("synthetic", "ses_a", NOW + MINUTE),
      message("synthetic", "ses_b", NOW + MINUTE),
      message("user", "ses_a", NOW + MINUTE),
      message("assistant", undefined, NOW + MINUTE),
    ]
    expect(countPeerMessages(messages, "ses_a", NOW)).toBe(1)
    expect(countPeerMessages(messages, "ses_a", NOW - MINUTE)).toBe(2)
    expect(countPeerMessages(messages, "ses_b", NOW - MINUTE)).toBe(1)
    expect(countPeerMessages(messages, "ses_unknown", NOW - MINUTE)).toBe(0)
  })

  test("the window is exclusive", () => {
    expect(countPeerMessages([message("synthetic", "ses_a", NOW)], "ses_a", NOW)).toBe(0)
  })

  test("ignores a message without metadata", () => {
    expect(countPeerMessages([{ type: "synthetic", time: { created: NOW + MINUTE } }], "ses_a", NOW)).toBe(0)
  })
})

describe("toolHint", () => {
  test("takes the first usable field", () => {
    expect(toolHint({ command: "npm test", filePath: "src/x.ts" })).toBe("npm test")
    expect(toolHint({ filePath: "src/x.ts" })).toBe("src/x.ts")
    expect(toolHint({ pattern: "deploy" })).toBe("deploy")
  })

  test("skips empty and non-string values", () => {
    expect(toolHint({ command: "   ", filePath: "src/x.ts" })).toBe("src/x.ts")
    expect(toolHint({ command: 42, path: "src/y.ts" })).toBe("src/y.ts")
    expect(toolHint({})).toBe("")
    expect(toolHint(undefined)).toBe("")
    expect(toolHint("a string")).toBe("")
    expect(toolHint(null)).toBe("")
  })

  test("collapses newlines and truncates on one line", () => {
    expect(toolHint({ command: "npm test\n  --silent" })).toBe("npm test --silent")
    const hint = toolHint({ command: "a".repeat(150) })
    expect(hint.length).toBe(100)
    expect(hint.endsWith("…")).toBe(true)
  })
})

describe("renderPeerMessage", () => {
  test("writes the header, the guidance and the body", () => {
    const text = renderPeerMessage(meta({ kind: "note" }), "  Le port a changé.  ", false)
    const lines = text.split("\n")

    expect(lines[0]).toBe(`${MARKER} message from "Session A" (ses_aaaaaaaaaabbbbbbbbbb, /work)`)
    expect(text).toContain("No answer is expected")
    expect(text).not.toContain("tools.peers_send")
    expect(lines.at(-1)).toBe("Le port a changé.")
    expect(lines.at(-2)).toBe("")
  })

  test("a delegation asks to be reported once done or blocked", () => {
    const text = renderPeerMessage(meta({ kind: "delegate", fromTitle: "Session B" }), "Prends ce chantier.", false)
    expect(text).toContain(`${MARKER} delegation from "Session B"`)
    expect(text).toContain("delegating this work item to you")
    expect(text).toContain("report to your own user")
    expect(text).toContain("Send one short line back with peers_send when it is done or blocked")
  })

  test("a question carries the reply instruction with the sender id", () => {
    const text = renderPeerMessage(meta({ kind: "question" }), "Tu fais quoi ?", false)
    expect(text).toContain(`${MARKER} question from "Session A"`)
    expect(text).toContain('tools.peers_send({ target: "ses_aaaaaaaaaabbbbbbbbbb"')
    expect(text).toContain("Tu fais quoi ?")
  })

  test("expect_reply turns a note into a question", () => {
    const text = renderPeerMessage(meta({ kind: "note" }), "Confirme.", true)
    expect(text).toContain('tools.peers_send({ target: "ses_aaaaaaaaaabbbbbbbbbb"')
    expect(text).not.toContain("No answer is expected")
  })
})

describe("isPeerMessage / stripPeerEnvelope", () => {
  const body = "Première ligne.\n\nDeuxième ligne."

  test("recognises a session-bus message", () => {
    expect(isPeerMessage(renderPeerMessage(meta(), body, false))).toBe(true)
    expect(isPeerMessage(`  \n${MARKER} message from`)).toBe(true)
    expect(isPeerMessage("bonjour")).toBe(false)
    expect(isPeerMessage("")).toBe(false)
  })

  test("round-trips the body", () => {
    expect(stripPeerEnvelope(renderPeerMessage(meta(), body, false))).toBe(body)
    expect(stripPeerEnvelope(renderPeerMessage(meta({ kind: "question" }), body, false))).toBe(body)
    expect(stripPeerEnvelope(renderPeerMessage(meta({ kind: "delegate" }), body, false))).toBe(body)
  })

  test("leaves a plain message untouched", () => {
    expect(stripPeerEnvelope("bonjour")).toBe("bonjour")
    expect(stripPeerEnvelope("bonjour\n\nla suite")).toBe("bonjour\n\nla suite")
  })

  test("falls back to the trimmed text when there is no separator", () => {
    expect(stripPeerEnvelope(`${MARKER} message from "A" (ses_a, /work) sans corps`)).toBe(
      `${MARKER} message from "A" (ses_a, /work) sans corps`,
    )
  })
})
