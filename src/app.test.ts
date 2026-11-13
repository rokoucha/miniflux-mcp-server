import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApp } from './app.js'
import { loadEnv, type Env } from './config/env.js'
import { computeS256Challenge } from './oauth/pkce.js'
import { issueAccessToken } from './oauth/jwe.js'
import { Miniflux, publicEntry, publicFeed, record } from './miniflux.js'
import { ReplayStore } from './oauth/replay.js'

const servers: Server[] = []
let closeApp: (() => void) | undefined
let directory: string
let env: Env
let upstreamUrl: string
let origin: string
let requests: { path: string; method: string; body: unknown; token: unknown }[]
const secret = 'upstream-secret'
const rawFeed = {
  id: 1,
  title: 'Feed',
  site_url: 'https://example.com',
  feed_url: 'https://example.com/rss?key=secret',
  password: 'feed-password',
  username: 'secret-user',
  cookie: 'session=secret',
  apprise_service_urls: 'secret',
  category: { id: 2, title: 'Category' },
}
const rawEntry = {
  id: 10,
  feed_id: 1,
  title: 'Entry',
  content: '<p>Article</p>',
  status: 'unread',
  feed: rawFeed,
}
async function listen(app: ReturnType<typeof express>): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error()
      resolve(`http://127.0.0.1:${address.port}`)
    })
    servers.push(server)
  })
}
async function post(
  path: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return fetch(origin + path, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(body),
  })
}
async function register() {
  const response = await fetch(origin + '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { client_id: string }
}
async function authorize(
  client_id: string,
  scope = 'miniflux:read miniflux:write offline_access',
) {
  const verifier = 'a'.repeat(43)
  const query = new URLSearchParams({
    client_id,
    response_type: 'code',
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope,
    code_challenge_method: 'S256',
    code_challenge: computeS256Challenge(verifier),
    state: 'state-value',
    resource: origin + '/mcp',
  })
  const response = await fetch(origin + '/authorize?' + query)
  expect(response.status).toBe(200)
  expect(response.headers.get('referrer-policy')).toBe('same-origin')
  const html = await response.text()
  const request_token = /name="request_token" value="([^"]+)"/.exec(html)![1]!
  const csrf_token = /name="csrf_token" value="([^"]+)"/.exec(html)![1]!
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!
  const result = await post(
    '/authorize',
    { request_token, csrf_token, pat: secret },
    { Cookie: cookie, Origin: origin },
  )
  expect(result.status).toBe(302)
  const location = new URL(result.headers.get('location')!)
  expect(location.searchParams.get('state')).toBe('state-value')
  return {
    code: location.searchParams.get('code')!,
    code_verifier: verifier,
    client_id,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    grant_type: 'authorization_code',
  }
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'miniflux-test-'))
  requests = []
  const upstream = express()
  upstream.use(express.json())
  upstream.use((req, res) => {
    requests.push({
      path: req.originalUrl,
      method: req.method,
      body: req.body,
      token: req.headers['x-auth-token'],
    })
    if (req.headers['x-auth-token'] !== secret) {
      res.status(401).json({ error_message: 'secret echoed' })
      return
    }
    if (req.path === '/v1/me') {
      res.json({ id: 123 })
      return
    }
    if (req.path === '/v1/feeds') {
      res.json([rawFeed])
      return
    }
    if (req.path === '/v1/entries/10') {
      res.json(rawEntry)
      return
    }
    if (req.path === '/v1/entries' && req.method === 'GET') {
      res.json({ total: 1, entries: [rawEntry] })
      return
    }
    if (req.path === '/v1/redirect') {
      res.redirect('https://example.com')
      return
    }
    if (req.path === '/v1/large') {
      res.send('x'.repeat(10000))
      return
    }
    if (req.path === '/v1/slow') {
      setTimeout(() => res.json({ ok: true }), 100)
      return
    }
    res.status(204).end()
  })
  upstreamUrl = await listen(upstream)
  env = loadEnv({
    MINIFLUX_URL: upstreamUrl,
    DATABASE_PATH: join(directory, 'oauth.sqlite'),
  })
  const result = createApp(env)
  closeApp = result.close
  origin = await listen(result.app)
  env.issuer = origin
})
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  }
  closeApp?.()
  closeApp = undefined
  rmSync(directory, { recursive: true, force: true })
})

describe('OAuth and MCP', () => {
  it('discovers, registers, authenticates and binds single-use codes to PKCE', async () => {
    const unauth = await fetch(origin + '/mcp', { method: 'POST' })
    expect(unauth.status).toBe(401)
    expect(unauth.headers.get('www-authenticate')).toContain(
      origin + '/.well-known/oauth-protected-resource',
    )
    const metadata = record(
      await (
        await fetch(origin + '/.well-known/oauth-authorization-server')
      ).json(),
    )
    expect(metadata.registration_endpoint).toBe(origin + '/register')
    const client = await register()
    const grant = await authorize(client.client_id)
    expect(
      (await post('/token', { ...grant, code_verifier: 'b'.repeat(43) }))
        .status,
    ).toBe(400)
    expect(
      (
        await post('/token', {
          ...grant,
          resource: 'https://wrong.example/mcp',
        })
      ).status,
    ).toBe(400)
    const response = await post('/token', grant)
    expect(response.status).toBe(200)
    const token = record(await response.json())
    expect(token.access_token).not.toContain(secret)
    expect((await post('/token', grant)).status).toBe(400)
    const sdk = new Client({ name: 'test', version: '1' })
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
        requestInit: {
          headers: { Authorization: `Bearer ${token.access_token}` },
        },
      }),
    )
    const tools = await sdk.listTools()
    expect(tools.tools.length).toBe(14)
    const result = await sdk.callTool({
      name: 'list_entries',
      arguments: { search: 'hello & world' },
    })
    expect(JSON.stringify(result)).not.toContain('feed-password')
    expect(JSON.stringify(result)).not.toContain('<p>Article</p>')
    expect(requests.at(-1)?.path).toContain('search=hello+%26+world')
    expect(requests.at(-1)?.token).toBe(secret)
    const entry = await sdk.callTool({
      name: 'get_entry',
      arguments: { entry_id: 10 },
    })
    expect(JSON.stringify(entry)).toContain('<p>Article</p>')
    expect(JSON.stringify(entry)).not.toContain('session=secret')
    await sdk.callTool({
      name: 'update_entries',
      arguments: { entry_ids: [10], status: 'read' },
    })
    expect(requests.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/v1/entries',
      body: { entry_ids: [10], status: 'read' },
    })
    const before = requests.length
    const invalid = await sdk.callTool({
      name: 'get_entry',
      arguments: { entry_id: -1 },
    })
    expect(invalid.isError).toBe(true)
    expect(requests).toHaveLength(before)
    await sdk.close()
  })
  it('refreshes once, retains narrowed permissions and rejects another audience', async () => {
    const client = await register()
    const token = record(
      await (await post('/token', await authorize(client.client_id))).json(),
    )
    const grant = {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: String(token.refresh_token),
    }
    expect(
      (
        await post('/token', {
          ...grant,
          resource: 'https://wrong.example/mcp',
        })
      ).status,
    ).toBe(400)
    const response = await post('/token', {
      ...grant,
      scope: 'miniflux:read offline_access',
    })
    expect(response.status).toBe(200)
    const narrowed = record(await response.json())
    expect((await post('/token', grant)).status).toBe(400)
    expect(
      (
        await post('/token', {
          ...grant,
          refresh_token: String(narrowed.refresh_token),
          scope: 'miniflux:write offline_access',
        })
      ).status,
    ).toBe(400)
    const sdk = new Client({ name: 'test', version: '1' })
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
        requestInit: {
          headers: { Authorization: `Bearer ${narrowed.access_token}` },
        },
      }),
    )
    const before = requests.length
    const result = await sdk.callTool({
      name: 'delete_feed',
      arguments: { feed_id: 1 },
    })
    expect(result.isError).toBe(true)
    expect(requests).toHaveLength(before)
    await sdk.close()
    const final = await post('/token', {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: String(narrowed.refresh_token),
      scope: 'miniflux:read',
    })
    expect(final.status).toBe(200)
    expect(record(await final.json()).refresh_token).toBeUndefined()
  })
  it('rejects invalid redirects and cross-origin requests', async () => {
    const response = await fetch(origin + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }),
    })
    expect(response.status).toBe(400)
    expect(
      (
        await fetch(origin + '/mcp', {
          method: 'POST',
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403)
    const client = await register()
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://evil.example',
    })
    const bad = await fetch(origin + '/authorize?' + query, {
      redirect: 'manual',
    })
    expect(bad.status).toBe(400)
    expect(bad.headers.get('location')).toBeNull()
    expect(
      (
        await post('/authorize', {
          request_token: 'fake',
          csrf_token: 'fake',
          pat: secret,
        })
      ).status,
    ).toBe(400)
  })
  it('rejects access tokens issued for another server', async () => {
    const token = await issueAccessToken(
      { ...env, issuer: 'https://other.example' },
      {
        client_id: 'test',
        scope: 'miniflux:read',
        origin: upstreamUrl,
        sub: '123',
        miniflux_user_id: '123',
        pat: secret,
      },
    )
    expect(
      (
        await fetch(origin + '/mcp', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401)
  })
})

it('removes sensitive configuration from feeds and embedded feeds', () => {
  for (const result of [publicFeed(rawFeed), publicEntry(rawEntry, true)]) {
    const json = JSON.stringify(result)
    for (const secret of [
      'feed-password',
      'secret-user',
      'session=secret',
      'rss?key=secret',
      'apprise_service_urls',
    ])
      expect(json).not.toContain(secret)
  }
})
it('limits upstream response size, forbids redirects and redacts errors', async () => {
  const api = new Miniflux({ ...env, maxResponseBytes: 1000 }, secret)
  await expect(api.request('/large')).rejects.toThrow(
    'reduce list_entries limit',
  )
  await expect(api.request('/redirect')).rejects.toThrow(
    'Miniflux request failed',
  )
  await expect(new Miniflux(env, 'invalid').request('/me')).rejects.toThrow(
    'HTTP 401',
  )
  await expect(
    new Miniflux({ ...env, timeoutMs: 10 }, secret).request('/slow'),
  ).rejects.toThrow('Miniflux request failed')
})
it('retains consumed grants across restarts', () => {
  const path = join(directory, 'replay.sqlite')
  const first = new ReplayStore(path)
  expect(first.consume('grant', Date.now() / 1000 + 60)).toBe(true)
  first.close()
  const next = new ReplayStore(path)
  expect(next.consume('grant', Date.now() / 1000 + 60)).toBe(false)
  next.close()
})
it('validates production configuration and integer limits', () => {
  expect(() =>
    loadEnv({
      NODE_ENV: 'production',
      MINIFLUX_URL: upstreamUrl,
      ISSUER: 'https://mcp.example',
    }),
  ).toThrow('JWE_KEYS_AUTHORIZE_REQUEST')
  expect(() =>
    loadEnv({ MINIFLUX_URL: upstreamUrl, PORT: '3000bad' }),
  ).toThrow()
  expect(() =>
    loadEnv({ MINIFLUX_URL: 'https://user:password@example.com' }),
  ).toThrow()
})

it('does not issue unusable refresh grants to code-only clients', async () => {
  const response = await fetch(origin + '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      token_endpoint_auth_method: 'none',
    }),
  })
  const client = record(await response.json())
  const token = record(
    await (
      await post('/token', await authorize(String(client.client_id)))
    ).json(),
  )
  expect(token.access_token).toBeTypeOf('string')
  expect(token.refresh_token).toBeUndefined()
})
