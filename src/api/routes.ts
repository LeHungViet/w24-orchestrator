/**
 * W24 Orchestrator — REST API
 *
 * Internal API called by W24 Admin CMS / W24 API.
 * All endpoints require X-Internal-Key header.
 */

import { Router, Request, Response } from 'express'
import { config } from '../config.js'
import {
  spawnInstance, stopInstance, restartInstance,
  healthCheck, getInstance, getAllInstances,
  suspendIdleInstances,
} from '../core/instance-manager.js'
import { provisionAgent } from '../core/provisioner.js'
import { startBotProxy, stopBotProxy } from '../telegram/proxy.js'
import { syncBrainToWorkspace } from '../core/brain-sync.js'
import { recordActivity, recordUsage } from '../core/activity-collector.js'

export const router = Router()

// Auth middleware
router.use((req: Request, res: Response, next) => {
  const key = req.headers['x-internal-key']
  if (key !== config.internalKey) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
})

/**
 * GET /api/instances — List all running OC instances
 */
router.get('/instances', (_req: Request, res: Response) => {
  const instances = getAllInstances()
  res.json({
    count: instances.length,
    instances: instances.map(i => ({
      agentId: i.agentId,
      agentName: i.agentName,
      tenantId: i.tenantId,
      port: i.port,
      pid: i.pid,
      status: i.status,
      lastMessageAt: new Date(i.lastMessageAt).toISOString(),
      startedAt: i.startedAt ? new Date(i.startedAt).toISOString() : null,
      idleMinutes: Math.round((Date.now() - i.lastMessageAt) / 60000),
    })),
  })
})

/**
 * POST /api/provision — Provision workspace for an agent
 */
router.post('/provision', async (req: Request, res: Response) => {
  const { tenant_id, agent_id } = req.body
  if (!tenant_id || !agent_id) {
    res.status(400).json({ error: 'tenant_id and agent_id required' })
    return
  }

  const result = await provisionAgent(tenant_id, agent_id)
  res.status(result.success ? 200 : 500).json(result)
})

/**
 * POST /api/deploy — Deploy (spawn) an agent's OC instance
 */
router.post('/deploy', async (req: Request, res: Response) => {
  const { tenant_id, agent_id, agent_name, home_path, telegram_token } = req.body
  if (!tenant_id || !agent_id || !agent_name || !home_path) {
    res.status(400).json({ error: 'tenant_id, agent_id, agent_name, home_path required' })
    return
  }

  try {
    const instance = await spawnInstance(tenant_id, agent_id, agent_name, home_path, telegram_token)

    // Start Telegram proxy if token provided
    if (telegram_token) {
      startBotProxy(agent_id, agent_name, telegram_token)
    }

    res.json({
      success: true,
      port: instance.port,
      pid: instance.pid,
      status: instance.status,
    })
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    })
  }
})

/**
 * POST /api/stop — Stop an agent's OC instance
 */
router.post('/stop', async (req: Request, res: Response) => {
  const { agent_id } = req.body
  if (!agent_id) {
    res.status(400).json({ error: 'agent_id required' })
    return
  }

  try {
    await stopInstance(agent_id)
    stopBotProxy(agent_id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    })
  }
})

/**
 * POST /api/restart — Restart an agent (drain → stop → start)
 */
router.post('/restart', async (req: Request, res: Response) => {
  const { agent_id } = req.body
  if (!agent_id) {
    res.status(400).json({ error: 'agent_id required' })
    return
  }

  try {
    const instance = await restartInstance(agent_id)
    res.json({
      success: true,
      port: instance.port,
      pid: instance.pid,
    })
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    })
  }
})

/**
 * GET /api/health/:agentId — Health check specific instance
 */
router.get('/health/:agentId', async (req: Request, res: Response) => {
  const instance = getInstance(req.params.agentId as string)
  if (!instance) {
    res.status(404).json({ healthy: false, error: 'Instance not found' })
    return
  }

  const result = await healthCheck(instance.port)
  res.json({
    agentId: req.params.agentId,
    agentName: instance.agentName,
    port: instance.port,
    ...result,
  })
})

/**
 * POST /api/suspend-scan — Trigger idle suspend scan
 */
router.post('/suspend-scan', async (_req: Request, res: Response) => {
  const suspended = await suspendIdleInstances()
  res.json({ suspended })
})

// ─────────────────────────────────────────────
// Sprint 0.3 — Brain Sync + Activity + Usage
// ─────────────────────────────────────────────

/**
 * POST /api/brain-sync — Sync brain documents to OC workspace
 * Called by W24 API after brain document upload/delete.
 */
router.post('/brain-sync', async (req: Request, res: Response) => {
  const { tenant_id } = req.body
  if (!tenant_id) {
    res.status(400).json({ error: 'tenant_id required' })
    return
  }

  try {
    const result = await syncBrainToWorkspace(tenant_id)
    res.json(result)
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    })
  }
})

/**
 * POST /api/activity/webhook — Receive activity events from OC instances.
 * OC gateway calls this after each agent turn.
 */
router.post('/activity/webhook', async (req: Request, res: Response) => {
  const { tenant_id, agent_id, action, summary, metadata, usage } = req.body
  if (!tenant_id || !agent_id || !action) {
    res.status(400).json({ error: 'tenant_id, agent_id, action required' })
    return
  }

  // Record activity
  await recordActivity({ tenantId: tenant_id, agentId: agent_id, action, summary: summary || '', metadata })

  // Record usage if token data provided
  if (usage?.model && (usage?.tokens_in || usage?.tokens_out)) {
    await recordUsage({
      tenantId: tenant_id,
      agentId: agent_id,
      eventType: action,
      modelUsed: usage.model,
      tokensIn: usage.tokens_in || 0,
      tokensOut: usage.tokens_out || 0,
      metadata: usage.metadata,
    })
  }

  res.json({ recorded: true })
})

/**
 * POST /api/usage/record — Direct usage event recording.
 * For batch imports or manual entries.
 */
router.post('/usage/record', async (req: Request, res: Response) => {
  const { tenant_id, agent_id, event_type, model_used, tokens_in, tokens_out, metadata } = req.body
  if (!tenant_id || !agent_id || !event_type) {
    res.status(400).json({ error: 'tenant_id, agent_id, event_type required' })
    return
  }

  await recordUsage({
    tenantId: tenant_id,
    agentId: agent_id,
    eventType: event_type,
    modelUsed: model_used || 'unknown',
    tokensIn: tokens_in || 0,
    tokensOut: tokens_out || 0,
    metadata,
  })

  res.json({ recorded: true })
})

/**
 * GET /api/status — Orchestrator status
 */
router.get('/status', (_req: Request, res: Response) => {
  const instances = getAllInstances()
  const running = instances.filter(i => i.status === 'running').length
  const suspended = instances.filter(i => i.status === 'suspended').length

  res.json({
    orchestrator: 'running',
    uptime_seconds: Math.round(process.uptime()),
    instances: {
      total: instances.length,
      running,
      suspended,
      stopped: instances.length - running - suspended,
    },
    config: {
      port_range: `${config.portRangeStart}-${config.portRangeEnd}`,
      idle_timeout_min: config.idleTimeoutMs / 60000,
      tenants_dir: config.tenantsDir,
    },
  })
})
