import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The OpenCode background service publishes its HTTP endpoint and password in a
 * registration file. A server plugin runs inside that service, so reading the
 * registration file is the plugin's way back to the public HTTP API (which
 * exposes session listing, unlike the in-process plugin context).
 */
export interface Endpoint {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

function registrationFiles(): readonly string[] {
  const state = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state")
  const config = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config")
  return [
    join(state, "opencode", "service.json"),
    join(state, "opencode", "service", "registration.json"),
    join(config, "opencode", "service.json"),
  ]
}

export function resolveEndpoint(): Endpoint | undefined {
  for (const file of registrationFiles()) {
    let registration: { url?: unknown; password?: unknown }
    try {
      registration = JSON.parse(readFileSync(file, "utf8")) as typeof registration
    } catch {
      continue
    }
    const { url, password } = registration
    if (typeof url !== "string" || typeof password !== "string") continue
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (parsed.hostname === "0.0.0.0" || parsed.hostname === "::") parsed.hostname = "127.0.0.1"
    const credentials = Buffer.from(`opencode:${password}`).toString("base64")
    return {
      url: parsed.origin,
      headers: { authorization: `Basic ${credentials}` },
    }
  }
  return undefined
}
