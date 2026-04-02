-- Sprint 0.2: Add oc_home_path column for Orchestrator workspace tracking
-- Run in Supabase SQL Editor

ALTER TABLE agents ADD COLUMN IF NOT EXISTS oc_home_path TEXT;

-- Update RLS: allow orchestrator (anon) to write oc_home_path
-- (Already covered by existing anon_write_agents policy from Sprint 0.4)

-- Add index on status for faster queries
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_tenant_status ON agents(tenant_id, status);
