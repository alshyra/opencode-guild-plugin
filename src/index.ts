import { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { join } from "node:path"

import { createApi } from "./api"
import { resolveEndpoint } from "./service"
import { Registry } from "./registry"
import { MemoryStore } from "./memory"
import { Delegations } from "./delegations"
import { isSessionID, type SessionLike } from "./peers"
import { Guards } from "./guards"
import { resolveOptions } from "./options"
import { registerTools, type Deps } from "./tools"
import { registerContextHook } from "./inject"
import { registerSkill } from "./skill"
import { enableDebug, debug, error, log, warn } from "./log"
import type { Ctx, Registration } from "./types"

export default Plugin.define({
  id: "guild",

  async setup(ctx) {
    const options = resolveOptions(ctx.options)
    const endpoint = resolveEndpoint()
    if (options.debug) {
      const state = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state")
      enableDebug(join(state, "opencode", "guild.log"))
    }
    log(`loading in ${ctx.location.directory} (project ${ctx.location.project.id})`)

    if (!endpoint) {
      warn("no OpenCode service registration file found: guild is disabled for this location")
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
    const memory = new MemoryStore(ctx.location.directory, {
      maxEntries: options.memoryMaxEntries,
      maxTextChars: options.memoryMaxChars,
      ttlMs: options.cacheTtlSeconds * 1000,
    })
    const deps: Deps = { ctx, registry, guards: new Guards(), options, api, memory, delegations: new Delegations() }

    const controller = new AbortController()
    void watchEvents(ctx, registry, controller.signal)

    const registrations: Registration[] = [
      await registerTools(ctx, deps),
      await registerContextHook(ctx, deps),
      await registerSkill(ctx, options),
    ]

    log(
      `ready (api ${endpoint.url}, permission ${options.permission}, scope ${options.scope}, memory ${options.memory ? "on" : "off"})`,
    )
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
        location: data["location"] as SessionLike["location"],
      })
    }
  } catch (cause) {
    if (!signal.aborted) error("event stream stopped", cause)
  }
}
