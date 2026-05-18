# HANDOFF — Wave 2 (m00-platform: auth / IAM / governance)

**Scope:** Per `docs/campusos-test-strategy-v3.html` Wave 2 — replace mock
specs for the m00-platform module with DB-backed integration tests.
Target: ≥95% coverage. Hot-path security surfaces (PermissionCheckService,
GuardianAuthorizationService, StudentOwnedGuard, TenantPrismaService,
governance/erasure).

**Approach:** Same conventions as Wave 1. Tests live under
`apps/api/test/integration/m00-platform/`. Use the cross-school harness
(School A vs School B) to verify scope chains, custody rules, and erasure
projections. Old mock specs stay in place until each replacement is
green; deleted incrementally.

## Step status

| Step | Title                                                                       | Status      |
| ---- | --------------------------------------------------------------------------- | ----------- |
| 1    | Extend `fixtures/platform.ts` with iam_scope rows for School A + School B    | ✅          |
| 2    | `m00-platform/permission-resolution.spec.ts` (PermissionCheckService — hot path; 19 tests) | ✅ |
| 2a   | Delete `m00-platform/iam/permission-check.service.spec.ts` (mock spec, 361 LOC — fully replaced) | ✅ |
| 3    | `m00-platform/guardian-authorization.spec.ts` (6 capabilities × custody × portal scope × court orders + audit log; 38 tests) | ✅ |
| 3a   | Delete `m00-platform/iam/guardian-authorization.{service,custody}.spec.ts` (2 mock specs, 898 LOC — fully replaced) | ✅ |
| 4    | `m00-platform/tenant-isolation.spec.ts` (TenantPrismaService SET LOCAL + tx rollback + concurrent isolation + explicit-schema + no-context error, 17 tests) | ✅ |
| 4a   | No mock spec to delete — TenantPrismaService had no dedicated unit spec | n/a |
| 5    | `m00-platform/governance-erasure.spec.ts` (ErasureService hasDpoScope + create/list/getById/update + pseudonymiseAuditLog atomic + IMMUTABLE dpo_pseudonymisation_log, 34 tests) | ✅ |
| 5a   | No mock spec for ErasureService to delete (service was added without a dedicated unit spec) | n/a |
| 6    | `m00-platform/student-owned.spec.ts` (assertStudentOwnsRecord — admin override + STUDENT bridge resolution + coach delegation stub, 14 tests) | ✅ |
| 6a   | Delete `shared/auth/student-owned.guard.spec.ts` (mock spec, 218 LOC — fully replaced) | ✅ |
| 7    | `m00-platform/configuration.spec.ts` (ConfigurationService.getSetupStatus 7-item ladder + SetupWizardService progress/UPSERT/bounds/resilient-loader, 16 tests) | ✅ |
| 7a   | No mock spec for ConfigurationService — service had no dedicated unit spec | n/a |
| 7b   | Deferred → RETIRED: `m00-platform/configuration-trees.spec.ts` covers FacilityTreeService, AcademicTreeService, PositionTreeService, ConnectionsSummaryService, BulkImportService (18 tests) | ✅ |

## Wave 2 — COMPLETE (all 6 strategy specs landed)

m00-platform IAM + governance + tenant-isolation + configuration surface
is now DB-backed. 138 integration tests added in Wave 2 (19 + 38 + 17 +
34 + 14 + 16). Zero new service-layer bugs surfaced — the services
were genuinely solid (one test bug corrected — `IN_PROGRESS` vs
`REVIEWING` for erasure status).
| 3    | `m00-platform/guardian-authorization.spec.ts` (6 capabilities + custody + court orders + audit log) | ⏳ pending |
| 4    | `m00-platform/student-owned.spec.ts` (decorator + guard across 6 student-owned tables) | ⏳ pending |
| 5    | `m00-platform/tenant-isolation.spec.ts` (executeInTenantContext SET LOCAL + is_frozen + concurrent isolation) | ⏳ pending |
| 6    | `m00-platform/governance-erasure.spec.ts` (Erasure + IMMUTABLE dpo_pseudonymisation_log + SAR + breach 72h) | ⏳ pending |
| 7    | `m00-platform/configuration.spec.ts` (school config CRUD + feature flags + presets) | ⏳ pending |

## Findings (TBD)

(Will accumulate as integration tests surface real bugs the mock specs hid.)
