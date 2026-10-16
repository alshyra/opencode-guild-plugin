import { describe, expect, test } from "bun:test"

import { Delegations, isDelegationRequest } from "../src/delegations.ts"
import { renderPeerMessage, type PeerMessageMeta } from "../src/envelope.ts"

const R = "ses_request"
const P = "ses_peer"

describe("Delegations", () => {
  test("register returns a dlg_ id and lists it as pending for the requester", () => {
    const delegations = new Delegations()
    const delegation = delegations.register({ requester: R, peer: P, task: "run the migration" })
    expect(delegation.id).toMatch(/^dlg_[0-9a-f]+$/)
    expect(delegation.resolvedAt).toBeUndefined()
    expect(delegations.pending(R).map((item) => item.id)).toEqual([delegation.id])
  })

  test("a report from the asked peer resolves the delegation", () => {
    const delegations = new Delegations()
    const delegation = delegations.register({ requester: R, peer: P, task: "check the logs" })
    const resolved = delegations.resolvePair(R, P)
    expect(resolved?.id).toBe(delegation.id)
    expect(delegations.get(delegation.id)?.resolvedAt).toBeGreaterThan(0)
    expect(delegations.pending(R)).toEqual([])
  })

  test("resolving is directional: the wrong direction or a stray peer finds nothing", () => {
    const delegations = new Delegations()
    delegations.register({ requester: R, peer: P, task: "x" })
    expect(delegations.resolvePair(P, R)).toBeUndefined()
    expect(delegations.resolvePair(R, "ses_other")).toBeUndefined()
    expect(delegations.pending(R)).toHaveLength(1)
  })

  test("resolve marks only the oldest outstanding delegation between the pair", () => {
    const delegations = new Delegations()
    const first = delegations.register({ requester: R, peer: P, task: "first", now: 1_000 })
    const second = delegations.register({ requester: R, peer: P, task: "second", now: 2_000 })
    expect(delegations.resolvePair(R, P)?.id).toBe(first.id)
    expect(delegations.pending(R).map((item) => item.id)).toEqual([second.id])
    expect(delegations.resolvePair(R, P)?.id).toBe(second.id)
    expect(delegations.resolvePair(R, P)).toBeUndefined()
  })

  test("pending is scoped to the requester and ordered oldest first", () => {
    const delegations = new Delegations()
    const later = delegations.register({ requester: R, peer: P, task: "later", now: 2_000 })
    const earlier = delegations.register({ requester: R, peer: "ses_b", task: "earlier", now: 1_000 })
    delegations.register({ requester: "ses_other", peer: P, task: "not mine" })
    expect(delegations.pending(R).map((item) => item.id)).toEqual([earlier.id, later.id])
  })

  test("forget drops a delegation that never made it out", () => {
    const delegations = new Delegations()
    const delegation = delegations.register({ requester: R, peer: P, task: "x" })
    delegations.forget(delegation.id)
    expect(delegations.get(delegation.id)).toBeUndefined()
    expect(delegations.pending(R)).toEqual([])
  })

  test("resolveById closes exactly the named delegation, not the pair's oldest", () => {
    const delegations = new Delegations()
    const first = delegations.register({ requester: R, peer: P, task: "first", now: 1_000 })
    const second = delegations.register({ requester: R, peer: P, task: "second", now: 2_000 })
    expect(delegations.resolveById(second.id)?.id).toBe(second.id)
    expect(delegations.pending(R).map((item) => item.id)).toEqual([first.id])
    // An unknown or already-resolved id resolves nothing.
    expect(delegations.resolveById(second.id)).toBeUndefined()
    expect(delegations.resolveById("dlg_nope")).toBeUndefined()
  })

  test("isDelegationRequest tells a delegation request from a report", () => {
    expect(isDelegationRequest("delegate")).toBe(true)
    expect(isDelegationRequest("note")).toBe(false)
    expect(isDelegationRequest("question")).toBe(false)
  })

  test("stays bounded: never-answered delegations cannot grow the map forever", () => {
    const delegations = new Delegations()
    for (let index = 0; index < 300; index += 1) {
      delegations.register({ requester: R, peer: P, task: `task ${index}`, now: index })
    }
    // KEEP is 200; the trim keeps the newest.
    expect(delegations.pending(R).length).toBeLessThanOrEqual(200)
    expect(delegations.pending(R)[0]?.task).toBe("task 100")
  })
})

describe("delegation envelope", () => {
  const base: PeerMessageMeta = {
    bus: "guild",
    v: 1,
    from: "ses_peer",
    fromTitle: "peer",
    fromDirectory: "/tmp",
    kind: "delegate",
    hop: 0,
    ts: 0,
  }

  test("a delegation request tells the peer to quote the id back", () => {
    const text = renderPeerMessage({ ...base, delegation: "dlg_abc" }, "do the thing", true)
    expect(text).toContain('reply_to: "dlg_abc"')
    expect(text).toContain("match your report to this exact task")
  })

  test("a plain message carries no reply_to", () => {
    const text = renderPeerMessage(base, "just a note", false)
    expect(text).not.toContain("reply_to")
  })
})
