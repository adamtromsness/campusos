-- ═══════════════════════════════════════════════════════════════
-- CampusOS — Database Initialization
-- Runs once when the PostgreSQL container is first created.
-- ═══════════════════════════════════════════════════════════════

-- Extensions required by the platform
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- Create the platform schema (shared across all tenants)
CREATE SCHEMA IF NOT EXISTS platform;

-- Create a demo tenant schema (for local development)
CREATE SCHEMA IF NOT EXISTS tenant_demo;

-- Grant permissions to the campusos user
GRANT ALL ON SCHEMA platform TO campusos;
GRANT ALL ON SCHEMA tenant_demo TO campusos;

-- Set default search path for the campusos user
ALTER ROLE campusos SET search_path TO platform, public;

-- Log completion
DO $$
BEGIN
  RAISE NOTICE '🏫 CampusOS database initialized: platform + tenant_demo schemas created';
END $$;
