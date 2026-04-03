/**
 * W24 Orchestrator — Daemon WebSocket Handler
 *
 * Manages WSS connections from W24 Local Daemons.
 * Daemons connect here and await commands to execute on user's local machine.
 */

import { Server as HTTPServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { config } from '../config.js'
import { randomUUID } from 'crypto'

interface DaemonConnection {
  ws: WebSocket
  tenantId: string
  daemonVersion: string
  capabilities: string[]
  os: string
  connectedAt: number
  lastPing: number
}

interface PendingCommand {
  resolve: (result: any) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

// Active daemon connections keyed by tenantId
const daemons = new Map<string, DaemonConnection>()

// Pending command responses keyed by requestId
const pendingCommands = new Map<string, PendingCommand>()

/**
 * Initialize WebSocket server on the existing HTTP server
 */
export function initDaemonWSS(server: HTTPServer): void {
  const wss = new WebSocketServer({
    server,
    path: '/ws/daemon',
    verifyClient: (info, cb) => {
      // Verify auth token
      const authHeader = info.req.headers['authorization']
      const key = info.req.headers['x-internal-key']

      // Accept either Bearer token or internal key
      if (authHeader?.startsWith('Bearer ') || key === config.internalKey) {
        cb(true)
      } else {
        cb(false, 401, 'Unauthorized')
      }
    },
  })

  wss.on('connection', (ws, req) => {
    const tenantId = req.headers['x-tenant-id'] as string || 'unknown'
    console.log(`[WSS] Daemon connected: tenant=${tenantId}`)

    const conn: DaemonConnection = {
      ws,
      tenantId,
      daemonVersion: 'unknown',
      capabilities: [],
      os: 'unknown',
      connectedAt: Date.now(),
      lastPing: Date.now(),
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        handleDaemonMessage(conn, msg)
      } catch (err) {
        console.error(`[WSS] Bad message from ${tenantId}:`, err)
      }
    })

    ws.on('close', () => {
      console.log(`[WSS] Daemon disconnected: tenant=${tenantId}`)
      daemons.delete(tenantId)
    })

    ws.on('error', (err) => {
      console.error(`[WSS] Daemon error (${tenantId}):`, err.message)
    })

    // Store connection
    daemons.set(tenantId, conn)
  })

  // Heartbeat check every 60s
  setInterval(() => {
    for (const [tenantId, conn] of daemons) {
      if (Date.now() - conn.lastPing > 90000) { // 90s no heartbeat
        console.log(`[WSS] Daemon stale, closing: ${tenantId}`)
        conn.ws.terminate()
        daemons.delete(tenantId)
      }
    }
  }, 60000)

  console.log('[WSS] Daemon WebSocket server initialized at /ws/daemon')
}

function handleDaemonMessage(conn: DaemonConnection, msg: any) {
  switch (msg.type) {
    case 'daemon:hello':
      conn.daemonVersion = msg.version || 'unknown'
      conn.capabilities = msg.capabilities || []
      conn.os = msg.os || 'unknown'
      console.log(`[WSS] Daemon hello: tenant=${conn.tenantId} v=${conn.daemonVersion} os=${conn.os} caps=${conn.capabilities.join(',')}`)
      break

    case 'ping':
      conn.lastPing = Date.now()
      send(conn.ws, { type: 'pong' })
      break

    case 'command:result': {
      const pending = pendingCommands.get(msg.requestId)
      if (pending) {
        clearTimeout(pending.timeout)
        pendingCommands.delete(msg.requestId)
        if (msg.success) {
          pending.resolve(msg.result)
        } else {
          pending.reject(new Error(msg.error || 'Command failed'))
        }
      }
      break
    }

    default:
      console.log(`[WSS] Unknown daemon message: ${msg.type}`)
  }
}

function send(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

/**
 * Send a command to a tenant's daemon and await result
 */
export async function sendDaemonCommand(
  tenantId: string,
  action: string,
  params: Record<string, any>,
  timeoutMs = 30000
): Promise<any> {
  const conn = daemons.get(tenantId)
  if (!conn) {
    throw new Error(`No daemon connected for tenant ${tenantId}`)
  }

  const requestId = randomUUID()

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(requestId)
      reject(new Error(`Daemon command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    pendingCommands.set(requestId, { resolve, reject, timeout })

    send(conn.ws, {
      type: 'command',
      requestId,
      payload: { action, params },
    })
  })
}

/**
 * Check if a tenant has a daemon connected
 */
export function isDaemonConnected(tenantId: string): boolean {
  const conn = daemons.get(tenantId)
  return !!conn && conn.ws.readyState === WebSocket.OPEN
}

/**
 * Get all connected daemons info
 */
export function getDaemonConnections() {
  return Array.from(daemons.entries()).map(([tenantId, conn]) => ({
    tenantId,
    version: conn.daemonVersion,
    os: conn.os,
    capabilities: conn.capabilities,
    connectedAt: new Date(conn.connectedAt).toISOString(),
    uptimeMin: Math.round((Date.now() - conn.connectedAt) / 60000),
  }))
}
