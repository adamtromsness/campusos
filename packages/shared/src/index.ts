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

// ── Gender (standardised option set) ────────────────────────────
//
// The only gender values the UI offers and the only ones stored going
// forward (FIX: standardize Gender to Male / Female / Not Specified).
// Shared so the API validators/normaliser and both web forms can't drift.
// "Not Specified" is a valid satisfying choice for the required field;
// the empty string is only the disabled "Select…" placeholder.
export const GENDERS = ['MALE', 'FEMALE', 'NOT_SPECIFIED'] as const;
export type Gender = (typeof GENDERS)[number];

export const GENDER_LABELS: Record<Gender, string> = {
  MALE: 'Male',
  FEMALE: 'Female',
  NOT_SPECIFIED: 'Not Specified',
};

/**
 * Map any stored gender to the canonical set. Legacy single-letter codes
 * map by sex ('F'→FEMALE, 'M'→MALE); everything else (historical
 * NONBINARY/OTHER/UNDISCLOSED, blank, unknown) → NOT_SPECIFIED. Returned
 * on read so a value always matches the option set even before the
 * backfill runs or for rows it intentionally skips.
 */
export function normalizeGender(value: string | null | undefined): Gender {
  const v = (value ?? '').trim().toUpperCase();
  if (v === 'MALE' || v === 'M') return 'MALE';
  if (v === 'FEMALE' || v === 'F') return 'FEMALE';
  return 'NOT_SPECIFIED';
}
