/**
 * W24 Orchestrator — Tenant Provisioner
 *
 * Creates isolated OPENCLAW_HOME per tenant/agent:
 * - openclaw.json (gateway config)
 * - workspace/ (SOUL.md, TOOLS.md, MEMORY.md)
 * - workspace/skills/ (installed skills)
 * - agents/{name}/ (per-agent config)
 */

import { mkdirSync, writeFileSync, existsSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.js'
import { supabase } from './supabase.js'
import type { ProvisionResult } from './types.js'

/**
 * Provision a complete OPENCLAW_HOME for a tenant's agent
 */
export async function provisionAgent(
  tenantId: string,
  agentId: string
): Promise<ProvisionResult> {
  // 1. Fetch agent + tenant from DB
  const { data: agent, error } = await supabase
    .from('agents')
    .select('*, tenants!inner(name, slug)')
    .eq('id', agentId)
    .eq('tenant_id', tenantId)
    .single()

  if (error || !agent) {
    return { success: false, error: `Agent not found: ${error?.message}` }
  }

  const tenant = (agent as any).tenants
  const agentSlug = agent.name.toLowerCase().replace(/[^a-z0-9]/g, '-')
  const homePath = join(config.tenantsDir, tenant.slug, 'agents', agentSlug)

  try {
    // 2. Create directory structure
    const dirs = [
      homePath,
      join(homePath, 'workspace'),
      join(homePath, 'workspace', 'skills'),
      join(homePath, 'workspace', 'memory'),
      join(homePath, 'workspace', 'memory', 'log'),
      join(homePath, 'workspace', 'memory', 'lessons'),
      join(homePath, 'state'),
    ]
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true })
    }

    // 3. Generate openclaw.json
    const ocConfig = generateOpenClawConfig(agent, tenant)
    writeFileSync(join(homePath, 'openclaw.json'), JSON.stringify(ocConfig, null, 2))

    // 4. Generate workspace files
    generateWorkspaceFiles(homePath, agent)

    // 5. Install skills
    await installSkills(homePath, agentId)

    // 6. Update DB
    await supabase.from('agents').update({
      oc_home_path: homePath,
      status: 'provisioned',
      updated_at: new Date().toISOString(),
    }).eq('id', agentId)

    // 7. Log activity
    await supabase.from('activity_log').insert({
      tenant_id: tenantId,
      agent_id: agentId,
      action: 'agent_provisioned',
      summary: `Workspace provisioned at ${homePath}`,
      metadata: { homePath },
    })

    console.log(`[PROV] ✅ Provisioned ${agent.name} at ${homePath}`)
    return { success: true, homePath }

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[PROV] ❌ Failed to provision ${agent.name}: ${msg}`)
    return { success: false, error: msg }
  }
}

/**
 * Generate openclaw.json for a tenant agent
 */
function generateOpenClawConfig(agent: any, tenant: any): Record<string, unknown> {
  const modelId = agent.model_primary || 'openrouter/google/gemini-2.5-flash'
  const thinkingBudget = agent.model_thinking === 'off' ? 0 : (agent.thinking_budget || 8192)

  return {
    meta: {
      name: agent.name,
      version: '1.0.0',
    },
    models: {
      providers: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          api: 'openai-chat',
          authHeader: true,
        },
      },
      authProfiles: {
        platform: {
          provider: 'openrouter',
          apiKey: config.platformOpenRouterKey || '${OPENROUTER_API_KEY}',
        },
      },
      defaults: {
        model: modelId,
        streaming: true,
        thinking: {
          enabled: agent.model_thinking !== 'off',
          budget: thinkingBudget,
        },
      },
    },
    agents: {
      defaults: {
        model: modelId,
        sandbox: { mode: 'off' },
      },
      list: {
        main: {
          name: agent.name,
          model: modelId,
        },
      },
    },
    channels: {
      telegram: agent.telegram_bot_token ? {
        enabled: true,
        account: agent.name.toLowerCase(),
        token: agent.telegram_bot_token,
        longPoll: false,  // Orchestrator handles polling via proxy
      } : { enabled: false },
    },
    gateway: {
      auth: { token: generateGatewayToken() },
    },
    session: {
      contextWindow: 128000,
      compactThreshold: 0.7,
    },
  }
}

/**
 * Generate workspace files (SOUL.md, TOOLS.md, MEMORY.md)
 */
function generateWorkspaceFiles(homePath: string, agent: any) {
  const wsPath = join(homePath, 'workspace')

  // SOUL.md — from agent personality
  const soul = agent.personality || getDefaultSoul(agent.name)
  writeFileSync(join(wsPath, 'SOUL.md'), soul)

  // TOOLS.md — minimal default
  const tools = getDefaultTools(agent.name)
  writeFileSync(join(wsPath, 'TOOLS.md'), tools)

  // MEMORY.md — empty
  writeFileSync(join(wsPath, 'MEMORY.md'), `# Memory — ${agent.name}\n\n_Initialized ${new Date().toISOString()}_\n`)

  // AGENTS.md — single agent (main)
  const agents = `# Agents\n\n## main\n- **Name:** ${agent.name}\n- **Role:** AI Employee\n- **Model:** ${agent.model_id || 'gemini-2.5-flash-preview'}\n`
  writeFileSync(join(wsPath, 'AGENTS.md'), agents)

  console.log(`[PROV] Workspace files written: SOUL.md, TOOLS.md, MEMORY.md, AGENTS.md`)
}

/**
 * Install skills from DB → workspace/skills/
 */
async function installSkills(homePath: string, agentId: string) {
  const { data: skills } = await supabase
    .from('agent_skills')
    .select('*, skill_catalog!inner(slug, name, skill_template)')
    .eq('agent_id', agentId)

  if (!skills || skills.length === 0) {
    console.log(`[PROV] No skills to install`)
    return
  }

  const skillsDir = join(homePath, 'workspace', 'skills')

  for (const s of skills) {
    const catalog = (s as any).skill_catalog
    const skillDir = join(skillsDir, catalog.slug)
    mkdirSync(skillDir, { recursive: true })

    const template = catalog.skill_template || `# ${catalog.name}\n\nSkill template not yet defined.`
    writeFileSync(join(skillDir, 'SKILL.md'), template)
    console.log(`[PROV] Installed skill: ${catalog.slug}`)
  }
}

function getDefaultSoul(name: string): string {
  return `# ${name}

You are ${name}, an AI Employee powered by W24.ai Mission Control.

## Personality
- Helpful, professional, and friendly
- Respond in the same language as the user
- Keep responses concise and actionable

## Rules
- Always be honest about what you can and cannot do
- Ask clarifying questions when the request is ambiguous
- Use tools when they help accomplish the task
`
}

function getDefaultTools(name: string): string {
  return `# Tools — ${name}

## Available Tools
Standard tools are available through the OpenClaw gateway.

## Skill-Specific Tools
Skills may register additional tools. Check installed skills for details.
`
}

function generateGatewayToken(): string {
  const chars = 'abcdef0123456789'
  return Array.from({ length: 48 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}
