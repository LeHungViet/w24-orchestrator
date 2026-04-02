/**
 * CLI tool: Provision a tenant's agent workspace
 *
 * Usage: tsx src/cli/provision.ts <tenant_id> <agent_id>
 *    or: tsx src/cli/provision.ts --all  (provision all active agents)
 */

import { provisionAgent } from '../core/provisioner.js'
import { supabase } from '../core/supabase.js'

async function main() {
  const args = process.argv.slice(2)

  if (args[0] === '--all') {
    // Provision all active agents
    const { data: agents } = await supabase
      .from('agents')
      .select('id, name, tenant_id, status')
      .in('status', ['active', 'provisioned', 'pending'])

    if (!agents || agents.length === 0) {
      console.log('No agents to provision')
      return
    }

    console.log(`Provisioning ${agents.length} agents...\n`)

    for (const agent of agents) {
      const result = await provisionAgent(agent.tenant_id, agent.id)
      if (result.success) {
        console.log(`✅ ${agent.name} → ${result.homePath}`)
      } else {
        console.log(`❌ ${agent.name} → ${result.error}`)
      }
    }
  } else if (args.length === 2) {
    const [tenantId, agentId] = args
    const result = await provisionAgent(tenantId, agentId)
    console.log(result)
  } else {
    console.log('Usage:')
    console.log('  tsx src/cli/provision.ts <tenant_id> <agent_id>')
    console.log('  tsx src/cli/provision.ts --all')
  }

  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
