/**
 * W24 Orchestrator — Configuration
 */

export const config = {
  // Server
  port: parseInt(process.env.PORT || process.env.ORCHESTRATOR_PORT || '3500'),
  internalKey: process.env.INTERNAL_API_KEY || 'w24-orch-dev-key',

  // Supabase
  supabaseUrl: process.env.SUPABASE_URL || 'https://lnjthfmqcsogubyadinl.supabase.co',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',

  // OC paths
  ocBinary: process.env.OC_BINARY || 'openclaw',
  tenantsDir: process.env.TENANTS_DIR || '/tmp/w24-tenants',

  // Port range for OC instances
  portRangeStart: parseInt(process.env.PORT_RANGE_START || '18800'),
  portRangeEnd: parseInt(process.env.PORT_RANGE_END || '18899'),

  // Idle suspend
  idleTimeoutMs: parseInt(process.env.IDLE_TIMEOUT_MS || String(15 * 60 * 1000)), // 15 min
  healthCheckIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '30000'), // 30s
  suspendScanIntervalMs: parseInt(process.env.SUSPEND_SCAN_INTERVAL_MS || String(5 * 60 * 1000)), // 5 min

  // Telegram proxy
  telegramProxyEnabled: process.env.TELEGRAM_PROXY !== 'false',

  // Platform OpenRouter key (injected into tenant configs)
  platformOpenRouterKey: process.env.W24_OPENROUTER_KEY || '',
}
