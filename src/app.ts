import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Env } from './config/env.js'
import {
  createBearerAuthMiddleware,
  type AuthedRequest,
} from './oauth/context.js'
import { createOAuthRouter } from './oauth/routes.js'
import { ReplayStore } from './oauth/replay.js'
import { createServer } from './server.js'

export function createApp(env: Env) {
  const replay = new ReplayStore(env.databasePath)
  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    })
    // Origins are compared against configuration, never proxy/client-supplied Host.
    if (req.headers.origin && req.headers.origin !== env.issuer) {
      res.status(403).json({ error: 'invalid_origin' })
      return
    }
    next()
  })
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })
  app.use(createOAuthRouter(env, replay))
  const auth = createBearerAuthMiddleware(env)
  app.post(
    '/mcp',
    auth,
    express.json({ limit: '64kb' }),
    async (req: AuthedRequest, res, next) => {
      const server = createServer(env)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      try {
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
      } catch (error) {
        await transport.close()
        await server.close()
        next(error)
      }
    },
  )
  app.all('/mcp', auth, (_req, res) => {
    res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' })
  })
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' })
  })
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const status = (error as { status?: number })?.status
      // Do not log exception messages: parsers/upstream libraries may include secrets.
      console.error(
        JSON.stringify({ event: 'request_failed', status: status ?? 500 }),
      )
      if (!res.headersSent)
        res
          .status(status && [400, 413, 415].includes(status) ? status : 500)
          .json({ error: 'request_failed' })
    },
  )
  return { app, close: () => replay.close() }
}
