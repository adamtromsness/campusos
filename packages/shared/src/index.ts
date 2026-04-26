/**
 * CampusOS Shared Types & Constants
 *
 * This package contains types, schemas, and constants shared between
 * the API (NestJS) and Web (Next.js) applications.
 */

// ── Organisation Types ──────────────────────────────────────────

export const ORG_TYPES = ['DISTRICT', 'MAT', 'INDEPENDENT_GROUP'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

// ── Plan Tiers ──────────────────────────────────────────────────

export const PLAN_TIERS = ['SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

// ── IAM Scope Types ─────────────────────────────────────────────

export const SCOPE_TYPES = [
  'PLATFORM',
  'DISTRICT',
  'SCHOOL',
  'DEPARTMENT',
  'CLASS',
  'ACTIVITY',
  'WORKFLOW',
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

// ── IAM Permission Tiers ────────────────────────────────────────

export const PERMISSION_TIERS = ['read', 'write', 'admin'] as const;
export type PermissionTier = (typeof PERMISSION_TIERS)[number];

// ── Account Types ───────────────────────────────────────────────

export const ACCOUNT_TYPES = ['HUMAN', 'SERVICE_ACCOUNT'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// ── Role Assignment Sources ─────────────────────────────────────

export const ASSIGNMENT_SOURCES = ['DIRECT', 'DERIVED', 'IMPORTED'] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

// ── API Response Envelope ───────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  meta?: {
    page?: number;
    pageSize?: number;
    total?: number;
  };
}

export interface ApiError {
  statusCode: number;
  message: string;
  error: string;
  details?: Record<string, unknown>;
}

// ── Health Check ────────────────────────────────────────────────

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  checks: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
    kafka: 'up' | 'down';
  };
}
