import { isAllowedRedirectUri } from '../oauth/redirect.js'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

export interface JweKeyEntry {
  kid: string
  key: Uint8Array
}
export interface JweKeySet {
  active: JweKeyEntry
  all: JweKeyEntry[]
}
export interface OAuthClientConfig {
  id: string
  secret?: string
  redirectUris: string[]
  grantTypes?: string[]
}
export interface Env {
  port: number
  issuer: string
  allowedOrigin: string
  databasePath: string
  timeoutMs: number
  maxResponseBytes: number
  oauth: {
    clients: OAuthClientConfig[]
    ttlSeconds: {
      authorizeRequest: number
      authorizationCode: number
      accessToken: number
      refreshToken: number
    }
    keys: Record<
      'authorizeRequest' | 'authorizationCode' | 'accessToken' | 'refreshToken',
      JweKeySet
    >
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const integer = (name: string, fallback: number) =>
    z.coerce
      .number()
      .int()
      .positive()
      .safe()
      .parse(source[name] ?? fallback)
  const url = (name: string, fallback?: string) => {
    const value = new URL(z.string().parse(source[name] ?? fallback))
    if (
      !['http:', 'https:'].includes(value.protocol) ||
      value.username ||
      value.password ||
      value.search ||
      value.hash ||
      value.pathname !== '/'
    )
      throw new Error(`${name} must be an HTTP(S) origin`)
    if (
      name === 'ISSUER' &&
      source.NODE_ENV === 'production' &&
      value.protocol !== 'https:'
    )
      throw new Error('ISSUER must use HTTPS in production')
    return value.origin
  }
  const keySet = (name: string): JweKeySet => {
    const raw = source[name]
    if (!raw && source.NODE_ENV === 'production')
      throw new Error(`${name} is required`)
    const all = raw
      ? raw.split(',').map((item) => {
          const match = /^([A-Za-z0-9_-]+):([A-Za-z0-9_-]{43})$/.exec(item)
          if (!match) throw new Error(`Invalid ${name}`)
          const key = Buffer.from(match[2]!, 'base64url')
          if (key.length !== 32) throw new Error(`Invalid ${name}`)
          return { kid: match[1]!, key }
        })
      : [{ kid: 'development', key: randomBytes(32) }]
    if (new Set(all.map((k) => k.kid)).size !== all.length)
      throw new Error(`Duplicate key ID in ${name}`)
    return { active: all[0]!, all }
  }
  const clients = z
    .array(
      z.object({
        id: z.string().min(1),
        secret: z.string().min(1).optional(),
        redirectUris: z.array(z.string().refine(isAllowedRedirectUri)).min(1),
      }),
    )
    .parse(JSON.parse(source.OAUTH_CLIENTS_JSON ?? '[]'))
  const port = integer('PORT', 3000)
  if (port > 65535) throw new Error('Invalid PORT')
  return {
    port,
    issuer: url('ISSUER', 'http://localhost:3000'),
    allowedOrigin: url('MINIFLUX_URL'),
    databasePath: source.DATABASE_PATH ?? './oauth.sqlite',
    timeoutMs: integer('UPSTREAM_TIMEOUT_MS', 15000),
    maxResponseBytes: integer('MAX_RESPONSE_BYTES', 4 * 1024 * 1024),
    oauth: {
      clients,
      ttlSeconds: {
        authorizeRequest: 600,
        authorizationCode: 60,
        accessToken: 900,
        refreshToken: 2592000,
      },
      keys: {
        authorizeRequest: keySet('JWE_KEYS_AUTHORIZE_REQUEST'),
        authorizationCode: keySet('JWE_KEYS_AUTHORIZATION_CODE'),
        accessToken: keySet('JWE_KEYS_ACCESS_TOKEN'),
        refreshToken: keySet('JWE_KEYS_REFRESH_TOKEN'),
      },
    },
  }
}
