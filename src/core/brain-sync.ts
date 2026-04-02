/**
 * Brain Sync — Syncs Company Brain documents into OC agent workspaces.
 *
 * Flow: brain_documents (Supabase) → BRAIN.md (OC workspace)
 *
 * When a tenant uploads a document, the API triggers brain-sync.
 * This module fetches all brain docs for the tenant, generates BRAIN.md,
 * and writes it to each agent's workspace.
 */

import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { getAllInstances } from './instance-manager.js'
import * as fs from 'fs/promises'
import * as path from 'path'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey)

interface BrainDoc {
  id: string
  filename: string
  file_type: string
  extracted_text: string | null
  extraction_status: string
  uploaded_at: string
}

/**
 * Sync all brain documents for a tenant into their agents' OC workspaces.
 * Generates a BRAIN.md file containing all extracted text.
 */
export async function syncBrainToWorkspace(tenantId: string): Promise<{
  success: boolean
  agentsSynced: number
  docsCount: number
  error?: string
}> {
  // 1. Fetch all brain docs for this tenant
  const { data: docs, error } = await supabase
    .from('brain_documents')
    .select('id, filename, file_type, extracted_text, extraction_status, uploaded_at')
    .eq('tenant_id', tenantId)
    .eq('extraction_status', 'done')
    .order('uploaded_at', { ascending: true })

  if (error) {
    return { success: false, agentsSynced: 0, docsCount: 0, error: error.message }
  }

  const brainDocs = (docs || []) as BrainDoc[]

  // 2. Generate BRAIN.md content
  const brainMd = generateBrainMd(brainDocs)

  // 3. Find all agents for this tenant (running instances)
  const instances = getAllInstances().filter(i => i.tenantId === tenantId)

  // 4. Also check DB for all agents of this tenant (may not be running)
  const { data: agents } = await supabase
    .from('agents')
    .select('id, name, oc_home_path')
    .eq('tenant_id', tenantId)
    .not('oc_home_path', 'is', null)

  // Collect unique workspace paths
  const workspacePaths = new Set<string>()

  // From running instances
  for (const inst of instances) {
    const wsPath = path.join(inst.homePath, '.openclaw', 'workspace')
    workspacePaths.add(wsPath)
  }

  // From DB records
  for (const agent of (agents || [])) {
    if (agent.oc_home_path) {
      const wsPath = path.join(agent.oc_home_path, '.openclaw', 'workspace')
      workspacePaths.add(wsPath)
    }
  }

  // 5. Write brain content into workspace:
  //    - BRAIN.md as standalone reference (agent can read with file tool)
  //    - Append brain section to SOUL.md (auto-injected into system prompt)
  let synced = 0
  for (const wsPath of workspacePaths) {
    try {
      await fs.mkdir(wsPath, { recursive: true })

      // Write standalone BRAIN.md
      await fs.writeFile(path.join(wsPath, 'BRAIN.md'), brainMd, 'utf-8')

      // Inject brain summary into SOUL.md (OC auto-injects this into system prompt)
      await injectBrainIntoSoul(wsPath, brainDocs)

      synced++
    } catch (err) {
      console.error(`[brain-sync] Failed to write brain to ${wsPath}:`, err)
    }
  }

  console.log(`[brain-sync] tenant=${tenantId} docs=${brainDocs.length} agents=${synced}`)

  return {
    success: true,
    agentsSynced: synced,
    docsCount: brainDocs.length,
  }
}

/**
 * Generate BRAIN.md from brain documents.
 * This file is injected into the OC agent's context as workspace knowledge.
 */
function generateBrainMd(docs: BrainDoc[]): string {
  if (docs.length === 0) {
    return `# Company Brain\n\nNo documents uploaded yet.\n`
  }

  const lines: string[] = [
    '# Company Brain',
    '',
    `> ${docs.length} document(s) in knowledge base. Last updated: ${new Date().toISOString().split('T')[0]}`,
    '',
    'Use this knowledge to answer questions accurately. Always cite the source document when referencing specific information.',
    '',
    '---',
    '',
  ]

  for (const doc of docs) {
    const date = new Date(doc.uploaded_at).toISOString().split('T')[0]
    lines.push(`## 📄 ${doc.filename}`)
    lines.push(`*Type: ${doc.file_type} | Uploaded: ${date}*`)
    lines.push('')

    if (doc.extracted_text) {
      // Truncate individual docs to 50K chars in BRAIN.md to stay within context limits
      const text = doc.extracted_text.length > 50_000
        ? doc.extracted_text.slice(0, 50_000) + '\n\n[... document truncated for context window]'
        : doc.extracted_text
      lines.push(text)
    } else {
      lines.push('*[Text extraction pending or empty]*')
    }

    lines.push('')
    lines.push('---')
    lines.push('')
  }

  const result = lines.join('\n')

  // Total BRAIN.md cap: 200K chars to stay within OC bootstrap limits
  if (result.length > 200_000) {
    return result.slice(0, 200_000) + '\n\n[... BRAIN.md truncated at 200K characters. Upload fewer or smaller documents.]'
  }

  return result
}

/**
 * Inject brain knowledge section into SOUL.md.
 * OC auto-injects SOUL.md into the system prompt, so brain content
 * becomes part of the agent's base context.
 *
 * Uses markers to safely replace the brain section on re-sync
 * without touching the rest of SOUL.md.
 */
const BRAIN_START = '<!-- COMPANY_BRAIN_START -->'
const BRAIN_END = '<!-- COMPANY_BRAIN_END -->'

async function injectBrainIntoSoul(wsPath: string, docs: BrainDoc[]): Promise<void> {
  const soulPath = path.join(wsPath, 'SOUL.md')

  let soulContent = ''
  try {
    soulContent = await fs.readFile(soulPath, 'utf-8')
  } catch {
    // SOUL.md doesn't exist — create minimal one
    soulContent = '# Agent Soul\n\nI am a helpful AI assistant.\n'
  }

  // Build brain section for SOUL.md (compact version — full text in BRAIN.md)
  let brainSection: string
  if (docs.length === 0) {
    brainSection = `${BRAIN_START}\n## Company Knowledge Base\n\nNo documents uploaded yet.\n${BRAIN_END}`
  } else {
    const docSummaries = docs.map(d => {
      const text = d.extracted_text || ''
      // Include up to 10K chars per doc in SOUL.md (compact)
      const truncated = text.length > 10_000
        ? text.slice(0, 10_000) + '\n[... read BRAIN.md for full document]'
        : text
      return `### ${d.filename}\n${truncated}`
    }).join('\n\n')

    brainSection = `${BRAIN_START}\n## Company Knowledge Base\n\n> **IMPORTANT:** You have ${docs.length} company document(s) loaded below. ALWAYS use this knowledge to answer questions. If asked about company policies, procedures, or internal info, the answer is HERE — do NOT say you don't have access.\n\n${docSummaries}\n${BRAIN_END}`
  }

  // Replace existing brain section or append
  if (soulContent.includes(BRAIN_START)) {
    const regex = new RegExp(`${BRAIN_START}[\\s\\S]*?${BRAIN_END}`, 'g')
    soulContent = soulContent.replace(regex, brainSection)
  } else {
    soulContent = soulContent.trimEnd() + '\n\n' + brainSection + '\n'
  }

  await fs.writeFile(soulPath, soulContent, 'utf-8')
}
