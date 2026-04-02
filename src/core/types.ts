/**
 * W24 Orchestrator — Core Types
 */

export interface OcInstance {
  tenantId: string
  agentId: string
  agentName: string
  port: number
  pid: number | null
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'draining' | 'suspended'
  homePath: string         // OPENCLAW_HOME for this instance
  lastMessageAt: number    // timestamp of last Telegram message
  startedAt: number | null
  telegramToken?: string   // bot token for this instance
}

export interface TenantConfig {
  tenantId: string
  tenantName: string
  slug: string
  agents: AgentConfig[]
}

export interface AgentConfig {
  agentId: string
  name: string
  personality: string      // SOUL.md content
  model: string            // e.g. "openrouter/google/gemini-2.5-flash-preview"
  thinkingLevel: string    // off/minimal/low/medium/high
  telegramToken: string
  skills: string[]         // skill slugs
  status: string
}

export interface ProvisionResult {
  success: boolean
  homePath?: string
  port?: number
  error?: string
}

export interface HealthResult {
  healthy: boolean
  latencyMs: number
  error?: string
}
