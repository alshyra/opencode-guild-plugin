import { appendFileSync } from "node:fs"

const PREFIX = "[guild]"

let debugFile: string | undefined

/**
 * Plugin console output is not captured by the OpenCode server log, so `debug: true`
 * mirrors every plugin line into a file next to the service state.
 */
export function enableDebug(file: string): void {
  debugFile = file
  write(`--- log opened (${new Date().toISOString()})`)
}

function write(line: string): void {
  if (!debugFile) return
  try {
    appendFileSync(debugFile, `${line}\n`)
  } catch {
    // logging must never break a session
  }
}

function format(args: readonly unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") return value
      if (value instanceof Error) return `${value.name}: ${value.message}`
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .join(" ")
}

export function debug(...args: unknown[]): void {
  write(`${new Date().toISOString()} DEBUG ${format(args)}`)
}

export function log(...args: unknown[]): void {
  write(`${new Date().toISOString()} INFO ${format(args)}`)
  console.log(PREFIX, ...args)
}

export function warn(...args: unknown[]): void {
  write(`${new Date().toISOString()} WARN ${format(args)}`)
  console.warn(PREFIX, ...args)
}

export function error(...args: unknown[]): void {
  write(`${new Date().toISOString()} ERROR ${format(args)}`)
  console.error(PREFIX, ...args)
}

export function humanAge(updated: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - updated) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}
