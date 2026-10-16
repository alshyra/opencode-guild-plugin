import type { Api } from "./api"
import { type Peer, describePeer } from "./peers"
import { humanAge, truncate } from "./log"

interface MessagePart {
  readonly type?: string
  readonly text?: string
  readonly name?: string
  readonly state?: { readonly status?: string; readonly input?: unknown; readonly error?: unknown }
  readonly content?: readonly MessagePart[]
}

interface SessionMessage {
  readonly type?: string
  readonly time?: { readonly created?: number }
  readonly text?: string
  readonly content?: readonly MessagePart[]
}

interface FileChange {
  readonly file?: string
  readonly status?: string
  readonly additions?: number
  readonly deletions?: number
}

export interface ActivityOptions {
  readonly messages: number
  readonly files: number
}

/**
 * What a peer session is doing: its recent transcript, the tools it ran, the
 * files its last turn changed, and the working copy of its directory.
 */
export async function describeActivity(api: Api, peer: Peer, options: ActivityOptions): Promise<string> {
  const [messages, sessionDiff, status] = await Promise.all([
    api
      .get<readonly SessionMessage[]>(`/api/session/${peer.id}/message`, { limit: options.messages * 3 })
      .catch(() => [] as readonly SessionMessage[]),
    api.get<readonly FileChange[]>(`/api/session/${peer.id}/diff`).catch(() => [] as readonly FileChange[]),
    peer.directory
      ? api
          .get<readonly FileChange[]>("/api/vcs/status", { "location[directory]": peer.directory })
          .catch(() => [] as readonly FileChange[])
      : Promise.resolve([] as readonly FileChange[]),
  ])

  const ordered = [...messages].sort((left, right) => (left.time?.created ?? 0) - (right.time?.created ?? 0))
  const conversation: string[] = []
  const tools: string[] = []
  for (const message of ordered) {
    if (message.type === "user" || message.type === "synthetic") {
      const text = (message.text ?? "").trim()
      if (text) conversation.push(`user: ${truncate(oneLine(text), 160)}`)
      continue
    }
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type === "text" && part.text?.trim()) {
        conversation.push(`assistant: ${truncate(oneLine(part.text), 160)}`)
      } else if (part.type === "tool" && part.name) {
        const hint = toolHint(part.state?.input)
        const failed = part.state?.status === "error" ? " (failed)" : ""
        tools.push(`${part.name}${hint ? ` ${hint}` : ""}${failed}`)
      }
    }
  }

  const sections: string[] = [`Activity of ${describePeer(peer)}`]
  sections.push(`Directory: ${peer.directory}`)
  if (conversation.length) {
    sections.push("", "Recent conversation (oldest first):", ...conversation.slice(-options.messages).map((line) => `- ${line}`))
  }
  if (tools.length) {
    sections.push("", "Tools it ran:", ...tools.slice(-options.messages).map((line) => `- ${line}`))
  }
  if (sessionDiff.length) {
    sections.push(
      "",
      "Files its last turn changed:",
      ...sessionDiff.slice(0, options.files).map((change) => `- ${describeChange(change)}`),
    )
  }
  if (status.length) {
    sections.push(
      "",
      `Uncommitted changes in ${peer.directory}:`,
      ...status.slice(0, options.files).map((change) => `- ${describeChange(change)}`),
    )
  }
  if (!conversation.length && !tools.length && !sessionDiff.length && !status.length) {
    sections.push("", "No recorded activity yet.")
  }
  sections.push("", `Last update: ${humanAge(peer.updated)}.`)
  return truncate(sections.join("\n"), 6000)
}

function describeChange(change: FileChange): string {
  const counts = [change.additions ? `+${change.additions}` : "", change.deletions ? `-${change.deletions}` : ""]
    .filter(Boolean)
    .join("/")
  return `${change.file ?? "?"} (${change.status ?? "changed"}${counts ? `, ${counts}` : ""})`
}

function toolHint(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  for (const key of ["command", "filePath", "path", "file", "pattern", "description", "url", "target", "query"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return truncate(oneLine(value), 100)
  }
  return ""
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}
