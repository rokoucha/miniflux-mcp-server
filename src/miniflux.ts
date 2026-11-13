import type { Env } from './config/env.js'

export class UpstreamError extends Error {
  constructor(public readonly status?: number) {
    super(
      status ? `Miniflux returned HTTP ${status}` : 'Miniflux request failed',
    )
  }
}

export class ResponseTooLargeError extends UpstreamError {
  constructor() {
    super()
    this.message =
      'Miniflux response exceeds MAX_RESPONSE_BYTES; reduce list_entries limit or increase the server limit'
  }
}

export class Miniflux {
  constructor(
    private env: Env,
    private token: string,
  ) {}
  async request(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.env.timeoutMs)
    try {
      const response = await fetch(`${this.env.allowedOrigin}/v1${path}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'X-Auth-Token': this.token,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new UpstreamError(response.status)
      }
      if (response.status === 204) return { ok: true }
      const reader = response.body?.getReader()
      if (!reader) return { ok: true }
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > this.env.maxResponseBytes) {
          await reader.cancel()
          throw new ResponseTooLargeError()
        }
        chunks.push(value)
      }
      if (!bytes) return { ok: true }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch (error) {
      if (error instanceof UpstreamError) throw error
      throw new UpstreamError()
    } finally {
      clearTimeout(timer)
    }
  }
}

// Miniflux embeds full feed configuration (including credentials) in entries.
// Only explicitly selected fields can leave this boundary.
export function publicFeed(value: unknown) {
  const f = record(value)
  return {
    ...pick(f, [
      'id',
      'title',
      'site_url',
      'checked_at',
      'parsing_error_count',
      'disabled',
    ]),
    ...(f.category
      ? { category: pick(record(f.category), ['id', 'title', 'hide_globally']) }
      : {}),
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UpstreamError()
  return value as Record<string, unknown>
}
export function pick(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(
    keys.filter((key) => key in value).map((key) => [key, value[key]]),
  )
}
export function publicEntry(value: unknown, content = false) {
  const e = record(value)
  return {
    ...pick(e, [
      'id',
      'feed_id',
      'title',
      'url',
      'comments_url',
      'author',
      'published_at',
      'created_at',
      'status',
      'starred',
      'reading_time',
      'tags',
      ...(content ? ['content'] : []),
    ]),
    ...(e.feed ? { feed: publicFeed(e.feed) } : {}),
  }
}
