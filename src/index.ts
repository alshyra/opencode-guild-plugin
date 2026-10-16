import { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { join } from "node:path"

import { createApi } from "./api"
import { resolveEndpoint } from "./service"
import { Registry, isSessionID, type SessionInfo } from "./registry"
import { Guards } from "./guards"
import { resolveOptions } from "./options"
import { registerTools, type Deps } from "./tools"
import { registerPeersContextHook } from "./inject"
import { registerSkill } from "./skill"
import { enableDebug, debug, error, log, warn } from "./log"
import type { Ctx, Registration } from "./types"

export default Plugin.define({
  id: "session-bus",

  async setup(ctx) {
    const options = resolveOptions(ctx.options)
    const endpoint = resolveEndpoint()
    if (options.debug) {
      const state = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state")
      enableDebug(join(state, "opencode", "session-bus.log"))
    }
    log(`loading in ${ctx.location.directory} (project ${ctx.location.project.id})`)

    if (!endpoint) {
      warn("no OpenCode service registration file found: session-bus is disabled for this location")
      return
    }

    const api = createApi(endpoint)
    const registry = new Registry(
      api,
      { projectID: ctx.location.project.id, directory: ctx.location.directory },
      {
        ttlMs: options.cacheTtlSeconds * 1000,
        idleWindowMs: options.idleWindowMinutes * 60_000,
        maxPeers: Math.max(options.maxPeers, 20),
      },
    )
    const deps: Deps = { ctx, registry, guards: new Guards(), options }

    const controller = new AbortController()
    void watchEvents(ctx, registry, controller.signal)

    const registrations: Registration[] = [
      await registerTools(ctx, deps),
      await registerPeersContextHook(ctx, deps),
      await registerSkill(ctx),
    ]

    log(`ready (api ${endpoint.url}, permission ${options.permission}, scope ${options.scope})`)
    debug(
      "tools",
      (await ctx.tool.list()).map((tool) => tool.id),
    )

    return async () => {
      controller.abort()
      for (const registration of registrations) {
        await registration.dispose().catch((cause: unknown) => warn("cleanup failed", cause))
      }
    }
  },
})

async function watchEvents(ctx: Ctx, registry: Registry, signal: AbortSignal): Promise<void> {
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      const type = typeof event?.type === "string" ? event.type : ""
      if (!type.startsWith("session.")) continue
      if (type === "session.created" || type === "session.renamed" || type === "session.deleted") {
        registry.invalidate()
      }
      if (type !== "session.created") continue
      const data = (event as { data?: Record<string, unknown> }).data
      if (!data || !isSessionID(data["sessionID"])) continue
      registry.note({
        id: data["sessionID"],
        parentID: isSessionID(data["parentID"]) ? data["parentID"] : undefined,
        projectID: typeof data["projectID"] === "string" ? data["projectID"] : undefined,
        title: typeof data["title"] === "string" ? data["title"] : undefined,
        location: data["location"] as SessionInfo["location"],
      })
    }
  } catch (cause) {
    if (!signal.aborted) error("event stream stopped", cause)
  }
}
