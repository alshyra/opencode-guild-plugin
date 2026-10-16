export const BUS_ID = "session-bus"
export const MARKER = "[session-bus]"

export interface PeerMessageMeta {
  readonly bus: typeof BUS_ID
  readonly v: 1
  readonly from: string
  readonly fromTitle: string
  readonly fromDirectory: string
  readonly hop: number
  readonly ts: number
}

/**
 * Everything a peer needs to answer is carried in the message itself: a session
 * only ever sees the text, so the sender identity lives in the header line.
 */
export function renderPeerMessage(meta: PeerMessageMeta, message: string, expectReply: boolean): string {
  const guidance = expectReply
    ? `Answer with peers_send(target="${meta.from}", message="...").`
    : `No answer is expected. Do not call peers_send unless you have a concrete correction or question; report to your user instead.`
  return [
    `${MARKER} from "${meta.fromTitle}" (${meta.from}, ${meta.fromDirectory})`,
    guidance,
    "",
    message.trim(),
  ].join("\n")
}

export function isPeerMessage(text: string): boolean {
  return text.trimStart().startsWith(MARKER)
}
