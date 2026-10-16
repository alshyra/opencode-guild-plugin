import type { Endpoint } from "./service"

export interface Api {
  get<T>(path: string, params?: Readonly<Record<string, string | number | undefined>>, signal?: AbortSignal): Promise<T>
}

export function createApi(endpoint: Endpoint): Api {
  return {
    async get<T>(
      path: string,
      params?: Readonly<Record<string, string | number | undefined>>,
      signal?: AbortSignal,
    ): Promise<T> {
      const url = new URL(path, endpoint.url)
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
      const response = await fetch(url, { headers: endpoint.headers, signal })
      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`GET ${url.pathname} failed with ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`)
      }
      const body = (await response.json()) as { data?: T }
      return (body?.data ?? (body as T)) as T
    },
  }
}
