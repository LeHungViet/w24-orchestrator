/**
 * W24 Orchestrator — Entry Point
 *
 * Multi-tenant OC process manager.
 * Manages OpenClaw gateway instances, Telegram proxy, and idle suspend.
 */

import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { config } from './config.js'
import { router } from './api/routes.js'
import { daemonRouter } from './api/daemon-routes.js'
import { suspendIdleInstances } from './core/instance-manager.js'
import { startAllBotProxies, stopAllBotProxies } from './telegram/proxy.js'
import { initDaemonWSS } from './daemon/ws-handler.js'

const app = express()
app.use(express.json())

// Mount API routes
app.use('/api', router)
app.use('/api/daemon', daemonRouter)

// Public health endpoint (no auth)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'w24-orchestrator', uptime: Math.round(process.uptime()) })
})

// Create HTTP server (needed for WSS upgrade)
const httpServer = createServer(app)

// Initialize Daemon WebSocket server
initDaemonWSS(httpServer)

// Start server
const server = httpServer.listen(config.port, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║        W24 Orchestrator v0.2.0                   ║
║        Port: ${String(config.port).padEnd(35)}║
║        Tenants: ${config.tenantsDir.slice(0, 32).padEnd(32)}║
║        Ports: ${config.portRangeStart}-${String(config.portRangeEnd).padEnd(28)}║
║        Idle timeout: ${String(config.idleTimeoutMs / 60000).padEnd(28)}min║
╚══════════════════════════════════════════════════╝
  `)
})

// Start Telegram bot proxies for all active agents
if (config.telegramProxyEnabled) {
  startAllBotProxies().catch(err => {
    console.error('[MAIN] Failed to start Telegram proxies:', err)
  })
}

// Idle suspend cron
const suspendInterval = setInterval(async () => {
  try {
    const suspended = await suspendIdleInstances()
    if (suspended.length > 0) {
      console.log(`[CRON] Suspended ${suspended.length} idle instances`)
    }
  } catch (err) {
    console.error('[CRON] Suspend scan error:', err)
  }
}, config.suspendScanIntervalMs)

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n[MAIN] ${signal} received — shutting down...`)
  clearInterval(suspendInterval)
  stopAllBotProxies()
  httpServer.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
