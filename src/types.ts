import { Plugin } from "@opencode/plugin"

/**
 * The server plugin context, derived from `Plugin.define` so it always matches
 * the OpenCode release the plugin runs against.
 */
export type Ctx = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export type Registration = Awaited<ReturnType<Ctx["tool"]["transform"]>>
