import { createApp } from './app.js'
import { loadEnv } from './config/env.js'

const env = loadEnv()
const { app, close } = createApp(env)
const http = app.listen(env.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'listening', port: env.port }))
})
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    const timer = setTimeout(() => {
      http.closeAllConnections()
      close()
      process.exit(1)
    }, 10000)
    timer.unref()
    http.close(() => {
      clearTimeout(timer)
      close()
    })
    http.closeIdleConnections()
  })
