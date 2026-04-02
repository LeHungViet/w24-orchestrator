/**
 * W24 Orchestrator — OC Instance Manager
 *
 * Manages lifecycle of OpenClaw gateway instances:
 * - Spawn: create process with isolated OPENCLAW_HOME + port
 * - Stop: graceful kill (SIGTERM → SIGKILL after 10s)
 * - Health: HTTP ping to /health endpoint
 * - Suspend: kill idle instances, wake on-demand
 */

import { spawn, ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { config } from '../config.js'
import { supabase } from './supabase.js'
import type { OcInstance, HealthResult } from './types.js'

// In-memory registry of running instances
const instances = new Map<string, OcInstance>()
const processes = new Map<string, ChildProcess>()

// Port allocation
const usedPorts = new Set<number>()

function allocatePort(): number {
  for (let p = config.portRangeStart; p <= config.portRangeEnd; p++) {
    if (!usedPorts.has(p)) {
      usedPorts.add(p)
      return p
    }
  }
  throw new Error('No available ports in range')
}

function releasePort(port: number) {
  usedPorts.delete(port)
}

/**
 * Get all running instances
 */
export function getAllInstances(): OcInstance[] {
  return Array.from(instances.values())
}

/**
 * Get instance by agent ID
 */
export function getInstance(agentId: string): OcInstance | undefined {
  return instances.get(agentId)
}

/**
 * Spawn an OC gateway instance for an agent
 */
export async function spawnInstance(
  tenantId: string,
  agentId: string,
  agentName: string,
  homePath: string,
  telegramToken?: string
): Promise<OcInstance> {
  // Check if already running
  const existing = instances.get(agentId)
  if (existing && existing.status === 'running') {
    console.log(`[IM] Instance for ${agentName} already running on port ${existing.port}`)
    return existing
  }

  // Verify home path exists
  if (!existsSync(homePath)) {
    throw new Error(`OPENCLAW_HOME not found: ${homePath}`)
  }

  const port = allocatePort()
  console.log(`[IM] Spawning ${agentName} — home=${homePath} port=${port}`)

  const instance: OcInstance = {
    tenantId,
    agentId,
    agentName,
    port,
    pid: null,
    status: 'starting',
    homePath,
    lastMessageAt: Date.now(),
    startedAt: null,
    telegramToken,
  }
  instances.set(agentId, instance)

  // Spawn OC gateway process
  const env = {
    ...process.env,
    OPENCLAW_HOME: homePath,
    PORT: String(port),
    // Pass platform OpenRouter key so OC can resolve ${OPENROUTER_API_KEY}
    OPENROUTER_API_KEY: config.platformOpenRouterKey || process.env.OPENROUTER_API_KEY || '',
  }

  // Use 'gateway run' (foreground) instead of 'gateway start' (daemon/launchd)
  const proc = spawn(config.ocBinary, ['gateway', 'run', '--port', String(port), '--allow-unconfigured'], {
    env,
    cwd: homePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  processes.set(agentId, proc)
  instance.pid = proc.pid ?? null

  // Collect stdout/stderr for logging
  proc.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) console.log(`[${agentName}:${port}] ${line}`)
  })

  proc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) console.error(`[${agentName}:${port}:ERR] ${line}`)
  })

  proc.on('exit', (code, signal) => {
    console.log(`[IM] ${agentName} exited — code=${code} signal=${signal}`)
    instance.status = 'stopped'
    instance.pid = null
    processes.delete(agentId)
    releasePort(port)
  })

  // Wait for gateway to become healthy (max 30s)
  const healthy = await waitForHealth(port, 30000)
  if (healthy) {
    instance.status = 'running'
    instance.startedAt = Date.now()
    console.log(`[IM] ✅ ${agentName} running on port ${port}`)

    // Update DB
    await supabase.from('agents').update({
      status: 'active',
      oc_port: port,
      oc_pid: instance.pid,
      updated_at: new Date().toISOString(),
    }).eq('id', agentId)

    await logActivity(tenantId, agentId, 'agent_deployed', `${agentName} deployed on port ${port}`, {
      port, pid: instance.pid,
    })
  } else {
    console.error(`[IM] ❌ ${agentName} failed to start — killing`)
    await stopInstance(agentId)
    throw new Error(`${agentName} failed health check after 30s`)
  }

  return instance
}

/**
 * Stop an OC instance gracefully
 */
export async function stopInstance(agentId: string): Promise<void> {
  const instance = instances.get(agentId)
  const proc = processes.get(agentId)

  if (!instance || !proc) {
    console.log(`[IM] No running instance for ${agentId}`)
    instances.delete(agentId)
    return
  }

  console.log(`[IM] Stopping ${instance.agentName}...`)
  instance.status = 'stopping'

  // SIGTERM first
  proc.kill('SIGTERM')

  // Wait up to 10s for graceful exit
  const exited = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10000)
    proc.on('exit', () => {
      clearTimeout(timeout)
      resolve(true)
    })
  })

  if (!exited) {
    console.log(`[IM] Force killing ${instance.agentName}`)
    proc.kill('SIGKILL')
  }

  // Cleanup
  instance.status = 'stopped'
  instance.pid = null
  processes.delete(agentId)
  releasePort(instance.port)

  // Update DB
  await supabase.from('agents').update({
    status: 'paused',
    oc_pid: null,
    updated_at: new Date().toISOString(),
  }).eq('id', agentId)

  await logActivity(instance.tenantId, agentId, 'agent_paused', `${instance.agentName} stopped`)
}

/**
 * Restart an instance (drain → stop → start)
 */
export async function restartInstance(agentId: string): Promise<OcInstance> {
  const instance = instances.get(agentId)
  if (!instance) throw new Error(`No instance for ${agentId}`)

  const { tenantId, agentName, homePath, telegramToken } = instance

  instance.status = 'draining'
  await supabase.from('agents').update({
    status: 'restarting',
    updated_at: new Date().toISOString(),
  }).eq('id', agentId)

  // Wait 5s for in-flight requests
  await new Promise(r => setTimeout(r, 5000))

  await stopInstance(agentId)
  return spawnInstance(tenantId, agentId, agentName, homePath, telegramToken)
}

/**
 * Health check a specific instance
 */
export async function healthCheck(port: number): Promise<HealthResult> {
  const start = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    const latencyMs = Date.now() - start
    if (res.ok) return { healthy: true, latencyMs }
    return { healthy: false, latencyMs, error: `HTTP ${res.status}` }
  } catch (err) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown',
    }
  }
}

/**
 * Record last message timestamp (for idle suspend)
 */
export function touchInstance(agentId: string) {
  const instance = instances.get(agentId)
  if (instance) {
    instance.lastMessageAt = Date.now()
  }
}

/**
 * Idle suspend scan — kill instances idle > threshold
 */
export async function suspendIdleInstances(): Promise<string[]> {
  const now = Date.now()
  const suspended: string[] = []

  for (const [agentId, instance] of instances) {
    if (instance.status !== 'running') continue
    const idleMs = now - instance.lastMessageAt
    if (idleMs > config.idleTimeoutMs) {
      console.log(`[SUSPEND] ${instance.agentName} idle for ${Math.round(idleMs / 60000)}min — suspending`)
      await stopInstance(agentId)
      instance.status = 'suspended'

      await supabase.from('agents').update({
        status: 'suspended',
        updated_at: new Date().toISOString(),
      }).eq('id', agentId)

      await logActivity(instance.tenantId, agentId, 'agent_suspended',
        `${instance.agentName} suspended after ${Math.round(idleMs / 60000)}min idle`)

      suspended.push(agentId)
    }
  }

  return suspended
}

/**
 * Wake a suspended instance on-demand
 */
export async function wakeInstance(agentId: string): Promise<OcInstance> {
  const instance = instances.get(agentId)
  if (instance && instance.status === 'running') return instance

  // Fetch agent config from DB
  const { data: agent } = await supabase
    .from('agents')
    .select('*, tenants!inner(name, slug)')
    .eq('id', agentId)
    .single()

  if (!agent) throw new Error(`Agent ${agentId} not found in DB`)

  const tenant = (agent as any).tenants
  const homePath = `${config.tenantsDir}/${tenant.slug}/agents/${agent.name.toLowerCase()}`

  console.log(`[WAKE] Waking ${agent.name}...`)
  await logActivity(agent.tenant_id, agentId, 'agent_waking', `${agent.name} waking on-demand`)

  return spawnInstance(agent.tenant_id, agentId, agent.name, homePath, agent.telegram_bot_token)
}

// --- Internal helpers ---

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await healthCheck(port)
    if (result.healthy) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

async function logActivity(tenantId: string, agentId: string, action: string, summary: string, metadata?: Record<string, unknown>) {
  try {
    await supabase.from('activity_log').insert({
      tenant_id: tenantId,
      agent_id: agentId,
      action,
      summary,
      metadata: metadata || {},
    })
  } catch (e) {
    console.error(`[LOG] Failed to log activity: ${e}`)
  }
}
