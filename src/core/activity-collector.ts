/**
 * Activity & Usage Collector
 *
 * Monitors OC gateway activity and writes to Supabase:
 * - activity_log: human-readable action feed
 * - usage_events: token/cost tracking per LLM call
 *
 * Two collection modes:
 * 1. Push: OC calls webhook after each agent turn (preferred)
 * 2. Pull: Orchestrator polls gateway status periodically (fallback)
 */

import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { getAllInstances } from './instance-manager.js'
import type { OcInstance } from './types.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey)

/**
 * Record an agent activity event (called by webhook or log parser).
 */
export async function recordActivity(params: {
  tenantId: string
  agentId: string
  action: string
  summary: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  const { error } = await supabase.from('activity_log').insert({
    tenant_id: params.tenantId,
    agent_id: params.agentId,
    action: params.action,
    summary: params.summary,
    metadata: params.metadata || {},
  })

  if (error) {
    console.error('[activity] Insert failed:', error.message)
  }
}

/**
 * Record a usage event (token consumption).
 */
export async function recordUsage(params: {
  tenantId: string
  agentId: string
  eventType: string
  modelUsed: string
  tokensIn: number
  tokensOut: number
  metadata?: Record<string, unknown>
}): Promise<void> {
  // Simple credit calculation: 1 credit per 1K tokens
  const totalTokens = params.tokensIn + params.tokensOut
  const credits = Math.ceil(totalTokens / 1000)

  const { error } = await supabase.from('usage_events').insert({
    tenant_id: params.tenantId,
    agent_id: params.agentId,
    event_type: params.eventType,
    model_used: params.modelUsed,
    tokens_in: params.tokensIn,
    tokens_out: params.tokensOut,
    credits_consumed: credits,
    metadata: params.metadata || {},
  })

  if (error) {
    console.error('[usage] Insert failed:', error.message)
  }
}

/**
 * Poll all running instances for their session status
 * and detect new activity since last check.
 *
 * Called periodically by the Orchestrator cron.
 */
export async function pollInstanceActivity(): Promise<number> {
  const instances = getAllInstances().filter(i => i.status === 'running')
  let eventsCollected = 0

  for (const instance of instances) {
    try {
      const count = await collectFromInstance(instance)
      eventsCollected += count
    } catch (err) {
      // Silent — instance may be busy
    }
  }

  return eventsCollected
}

// Track last known session count per agent to detect new activity
const lastSessionCount = new Map<string, number>()

async function collectFromInstance(instance: OcInstance): Promise<number> {
  // Call OC gateway status to check session activity
  const res = await fetch(`http://127.0.0.1:${instance.port}/health`, {
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) return 0

  // For now, just verify the instance is alive
  // Real activity collection happens via webhook (see routes.ts /api/activity/webhook)
  return 0
}
