/**
 * W24 Orchestrator — Daemon REST API
 *
 * REST endpoints for interacting with connected daemons.
 * Called by W24 API when web dashboard needs to exec on user's machine.
 */

import { Router, Request, Response } from 'express'
import { config } from '../config.js'
import { sendDaemonCommand, isDaemonConnected, getDaemonConnections } from '../daemon/ws-handler.js'

export const daemonRouter = Router()

// Auth middleware
daemonRouter.use((req: Request, res: Response, next) => {
  const key = req.headers['x-internal-key']
  if (key !== config.internalKey) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
})

/**
 * GET /api/daemon/connections — List connected daemons
 */
daemonRouter.get('/connections', (_req: Request, res: Response) => {
  const connections = getDaemonConnections()
  res.json({ count: connections.length, connections })
})

/**
 * GET /api/daemon/status/:tenantId — Check if daemon is connected
 */
daemonRouter.get('/status/:tenantId', (req: Request, res: Response) => {
  const connected = isDaemonConnected(req.params.tenantId)
  res.json({ tenantId: req.params.tenantId, connected })
})

/**
 * POST /api/daemon/exec — Execute command on tenant's daemon
 */
daemonRouter.post('/exec', async (req: Request, res: Response) => {
  const { tenant_id, action, params, timeout_ms } = req.body
  if (!tenant_id || !action) {
    res.status(400).json({ error: 'tenant_id and action required' })
    return
  }

  if (!isDaemonConnected(tenant_id)) {
    res.status(404).json({ error: 'No daemon connected for this tenant' })
    return
  }

  try {
    const result = await sendDaemonCommand(tenant_id, action, params || {}, timeout_ms || 30000)
    res.json({ success: true, result })
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Command failed',
    })
  }
})

/**
 * POST /api/daemon/pair — Generate pairing token for a tenant
 * Called from web dashboard to create a token that the daemon can use to pair.
 */
daemonRouter.post('/pair', async (req: Request, res: Response) => {
  const { tenant_id, tenant_name } = req.body
  if (!tenant_id || !tenant_name) {
    res.status(400).json({ error: 'tenant_id and tenant_name required' })
    return
  }

  // Generate pairing token (base64 of connection info)
  const pairingData = {
    token: config.internalKey, // In production: generate per-tenant token
    tenantId: tenant_id,
    tenantName: tenant_name,
    orchestratorUrl: process.env.PUBLIC_URL || `http://localhost:${config.port}`,
  }

  const pairingToken = Buffer.from(JSON.stringify(pairingData)).toString('base64')

  res.json({
    success: true,
    pairingToken,
    // QR code URL for the daemon to show
    qrUrl: `w24://pair?token=${pairingToken}`,
  })
})
