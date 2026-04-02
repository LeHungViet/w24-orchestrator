/**
 * W24 Orchestrator — Telegram Proxy
 *
 * Architecture:
 * 1. Orchestrator long-polls Telegram for EACH registered bot token
 * 2. When message arrives → find the right OC instance → forward via HTTP
 * 3. If OC instance is suspended → wake on-demand → queue → forward
 *
 * Why proxy instead of OC direct polling:
 * - Orchestrator controls wake/suspend lifecycle
 * - Single process manages all bots (less resource waste)
 * - Can queue messages during instance wake
 */

import TelegramBot from 'node-telegram-bot-api'
import { getInstance, touchInstance, wakeInstance, spawnInstance } from '../core/instance-manager.js'
import { supabase } from '../core/supabase.js'

// Bot instances per agent
const bots = new Map<string, TelegramBot>()

// Message queue for agents being woken
const messageQueues = new Map<string, Array<{ chatId: number; message: TelegramBot.Message }>>()

// Agent ID lookup by bot token
const tokenToAgentId = new Map<string, string>()

/**
 * Start Telegram polling for an agent's bot
 */
export function startBotProxy(agentId: string, agentName: string, botToken: string) {
  if (bots.has(agentId)) {
    console.log(`[TG] Bot for ${agentName} already running`)
    return
  }

  console.log(`[TG] Starting Telegram proxy for ${agentName}`)

  const bot = new TelegramBot(botToken, { polling: true })
  bots.set(agentId, bot)
  tokenToAgentId.set(botToken, agentId)

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id
    const text = msg.text || ''
    console.log(`[TG:${agentName}] Message from ${msg.from?.username || chatId}: ${text.slice(0, 50)}`)

    try {
      await routeMessage(agentId, agentName, chatId, msg, bot)
    } catch (err) {
      console.error(`[TG:${agentName}] Route error:`, err)
      try {
        await bot.sendMessage(chatId, '⏳ Đang khởi động... vui lòng thử lại sau vài giây.')
      } catch (_) { /* ignore send errors */ }
    }
  })

  bot.on('polling_error', (err) => {
    console.error(`[TG:${agentName}] Polling error: ${err.message}`)
  })
}

/**
 * Stop Telegram polling for an agent
 */
export function stopBotProxy(agentId: string) {
  const bot = bots.get(agentId)
  if (bot) {
    bot.stopPolling()
    bots.delete(agentId)
    console.log(`[TG] Stopped bot proxy for ${agentId}`)
  }
}

/**
 * Stop all bot proxies
 */
export function stopAllBotProxies() {
  for (const [agentId, bot] of bots) {
    bot.stopPolling()
    bots.delete(agentId)
  }
  console.log(`[TG] All bot proxies stopped`)
}

/**
 * Route a Telegram message to the correct OC instance
 */
async function routeMessage(
  agentId: string,
  agentName: string,
  chatId: number,
  msg: TelegramBot.Message,
  bot: TelegramBot
) {
  // Touch the instance (reset idle timer)
  touchInstance(agentId)

  // Get or wake the instance
  let instance = getInstance(agentId)

  if (!instance || instance.status !== 'running') {
    console.log(`[TG:${agentName}] Instance not running — waking...`)

    // Send typing indicator while waking
    await bot.sendChatAction(chatId, 'typing')

    try {
      instance = await wakeInstance(agentId)
    } catch (err) {
      console.error(`[TG:${agentName}] Failed to wake: ${err}`)
      await bot.sendMessage(chatId, '❌ Không thể khởi động. Vui lòng thử lại sau.')
      return
    }
  }

  // Forward message to OC gateway via HTTP
  await forwardToOC(instance.port, chatId, msg, agentName, bot)
}

/**
 * Forward a Telegram message to OC gateway's internal API
 *
 * OC Gateway accepts messages via WebSocket or HTTP bridge.
 * We use the HTTP /api/message endpoint.
 */
async function forwardToOC(
  port: number,
  chatId: number,
  msg: TelegramBot.Message,
  agentName: string,
  bot: TelegramBot
) {
  const sender = msg.from?.username || msg.from?.first_name || String(chatId)
  const text = msg.text || ''

  // OC Gateway expects messages via its channel protocol
  // For Telegram proxy mode, we forward the raw Telegram update
  // to the OC gateway's webhook endpoint
  const payload = {
    update_id: Date.now(),
    message: msg,
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/webhook/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      console.error(`[TG:${agentName}] OC returned ${res.status}`)
      // Fallback: try the Gateway API directly
      await forwardViaGatewayAPI(port, chatId, text, sender, agentName, bot)
    }
  } catch (err) {
    console.error(`[TG:${agentName}] Forward failed: ${err}`)
    // Fallback to gateway API
    await forwardViaGatewayAPI(port, chatId, text, sender, agentName, bot)
  }

  // Log activity
  const inst = getInstance(findAgentIdByName(agentName))
  if (inst) {
    await supabase.from('activity_log').insert({
      tenant_id: inst.tenantId,
      agent_id: findAgentIdByName(agentName),
      action: 'message_received',
      summary: `Telegram: ${sender} → "${text.slice(0, 100)}"`,
      metadata: {
        channel: 'telegram',
        chat_id: chatId,
        sender,
        text_length: text.length,
      },
    })
  }
}

/**
 * Fallback: forward via OC Gateway's WebSocket/REST API
 */
async function forwardViaGatewayAPI(
  port: number,
  chatId: number,
  text: string,
  sender: string,
  agentName: string,
  bot: TelegramBot
) {
  try {
    // Use OC's agent endpoint to send a message
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        channel: 'telegram',
        sender,
        peer: String(chatId),
      }),
      signal: AbortSignal.timeout(60000),
    })

    if (res.ok) {
      const data = await res.json() as any
      const reply = data?.response || data?.text || data?.content
      if (reply) {
        await bot.sendMessage(chatId, reply, { parse_mode: 'HTML' })
      }
    }
  } catch (err) {
    console.error(`[TG:${agentName}] Gateway API fallback failed: ${err}`)
  }
}

/**
 * Start proxies for all active agents from DB
 */
export async function startAllBotProxies() {
  // Only proxy agents that are managed by Orchestrator (have oc_home_path set)
  // Skip agents running on legacy OC Gateway (oc_home_path IS NULL)
  const { data: agents } = await supabase
    .from('agents')
    .select('id, name, telegram_bot_token, status, oc_home_path')
    .not('telegram_bot_token', 'is', null)
    .not('oc_home_path', 'is', null)
    .in('status', ['active', 'provisioned', 'suspended'])

  if (!agents || agents.length === 0) {
    console.log(`[TG] No Orchestrator-managed agents with Telegram tokens found (legacy OC agents skipped)`)
    return
  }

  for (const agent of agents) {
    if (agent.telegram_bot_token) {
      startBotProxy(agent.id, agent.name, agent.telegram_bot_token)
    }
  }

  console.log(`[TG] Started ${agents.length} bot proxies (legacy OC agents skipped)`)
}

function findAgentIdByName(name: string): string {
  // Lookup from the token→agentId map via bot name
  // In practice, the agentId is passed through the route flow
  // This is a fallback for logging
  for (const [token, agentId] of tokenToAgentId) {
    const instance = getInstance(agentId)
    if (instance?.agentName === name) return agentId
  }
  return ''
}
