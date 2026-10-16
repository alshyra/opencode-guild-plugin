export const BUS_ID = "session-bus"
export const MARKER = "[session-bus]"

export type PeerMessageKind = "note" | "handoff" | "question"

export interface PeerMessageMeta {
  readonly bus: typeof BUS_ID
  readonly v: 1
  readonly from: string
  readonly fromTitle: string
  readonly fromDirectory: string
  readonly kind: PeerMessageKind
  readonly hop: number
  readonly ts: number
}

const HEADLINE: Record<PeerMessageKind, string> = {
  note: "message from",
  handoff: "handoff from",
  question: "question from",
}

/**
 * Everything a peer needs to answer is carried in the message itself: a session
 * only ever sees the text, so the sender identity lives in the header line.
 */
export function renderPeerMessage(meta: PeerMessageMeta, body: string, expectReply: boolean): string {
  const guidance: string[] = []
  const replyHint =
    `To answer, send your text back to that session. In Code Mode, run ` +
    `return await tools.peers_send({ target: "${meta.from}", message: "your answer" }); ` +
    `otherwise call the peers_send tool.`
  if (meta.kind === "handoff") {
    guidance.push(
      `${meta.fromTitle} is handing you this work item. Treat it as a task from that session's user, and report to your own user. ` +
        "Send one short line back with peers_send when it is done or blocked: that is how the requester learns about it.",
    )
  }
  if (meta.kind === "question" || expectReply) {
    guidance.push(replyHint)
  } else if (meta.kind === "note") {
    guidance.push(
      "No answer is expected. Do not call peers_send unless you have a concrete correction or question; report to your user instead.",
    )
  }
  return [
    `${MARKER} ${HEADLINE[meta.kind]} "${meta.fromTitle}" (${meta.from}, ${meta.fromDirectory})`,
    ...guidance,
    "",
    body.trim(),
  ].join("\n")
}

export function isPeerMessage(text: string): boolean {
  return text.trimStart().startsWith(MARKER)
}

/** Drops the session-bus header of a received message, keeping the peer's own words. */
export function stripPeerEnvelope(text: string): string {
  const lines = text.split("\n")
  if (!isPeerMessage(text)) return text
  const separator = lines.findIndex((line, index) => index > 0 && line.trim() === "")
  return separator === -1 ? text.trim() : lines.slice(separator + 1).join("\n").trim()
}
