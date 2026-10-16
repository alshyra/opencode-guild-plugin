export const BUS_ID = "guild"
export const MARKER = "[guild]"

export type PeerMessageKind = "note" | "delegate" | "question"

export interface PeerMessageMeta {
  readonly bus: typeof BUS_ID
  readonly v: 1
  readonly from: string
  readonly fromTitle: string
  readonly fromDirectory: string
  readonly kind: PeerMessageKind
  readonly hop: number
  readonly ts: number
  /** Set on a delegation request: the id the peer must quote back in its report. */
  readonly delegation?: string
  /** Set on a report that answers a delegation. */
  readonly replyTo?: string
}

const HEADLINE: Record<PeerMessageKind, string> = {
  note: "message from",
  delegate: "delegation from",
  question: "question from",
}

/**
 * Everything a peer needs to answer is carried in the message itself: a session
 * only ever sees the text, so the sender identity lives in the header line.
 */
export function renderPeerMessage(meta: PeerMessageMeta, body: string, expectReply: boolean): string {
  const guidance: string[] = []
  const replyArgs = `{ target: "${meta.from}", message: "your answer"${
    meta.delegation ? `, reply_to: "${meta.delegation}"` : ""
  } }`
  const replyHint =
    `To answer, send your text back to that session. In Code Mode, run ` +
    `return await tools.peers_send(${replyArgs}); otherwise call the peers_send tool.` +
    (meta.delegation
      ? ` Pass reply_to so the requester can match your report to this exact task.`
      : "")
  if (meta.kind === "delegate") {
    guidance.push(
      `${meta.fromTitle} is delegating this work item to you and is keeping its own work going: treat it as a task from ` +
        "that session's user, and report to your own user. Send one short line back with peers_send when it is done or " +
        "blocked: that report is what wakes the requester.",
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

/** Drops the guild header of a received message, keeping the peer's own words. */
export function stripPeerEnvelope(text: string): string {
  const lines = text.split("\n")
  if (!isPeerMessage(text)) return text
  const separator = lines.findIndex((line, index) => index > 0 && line.trim() === "")
  return separator === -1 ? text.trim() : lines.slice(separator + 1).join("\n").trim()
}
