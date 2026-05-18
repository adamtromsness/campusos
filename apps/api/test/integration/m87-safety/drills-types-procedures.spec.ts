import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { DrillService } from '@modules/m87-safety/drills/drill.service';
import { IncidentTypeService } from '@modules/m87-safety/incidents/incident-type.service';
import { ProcedureService } from '@modules/m87-safety/emergency/procedure.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  studentActor,
  parentActor,
  teacherActor,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * DB-backed integration tests for three m87-safety services:
 *   - DrillService (CRUD + state machine + 90-day overdue surface)
 *   - IncidentTypeService (catalogue + platform-default protection)
 *   - ProcedureService (emergency procedures + JSONB shape)
 */
describe('integration:m87-safety/drills-types-procedures', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let drills: DrillService;
  let types: IncidentTypeService;
  let procedures: ProcedureService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    drills = new DrillService(tenantPrisma, permCheck);
    types = new IncidentTypeService(tenantPrisma, permCheck);
    procedures = new ProcedureService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_drills WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_emergency_procedures WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incident_types WHERE code LIKE 'TST-%' AND school_id IS NOT NULL`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantOfficer(codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  // ============================================================
  // DrillService
  // ============================================================
  describe('DrillService', () => {
    function baseDrill(overrides: Record<string, unknown> = {}) {
      return {
        procedureType: 'FIRE_EVACUATION' as const,
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        notes: 'Quarterly fire drill',
        ...overrides,
      };
    }

    it('admin creates a SCHEDULED drill', async () => {
      const d = await withTestTenant(async () => drills.create(baseDrill(), adminActor()));
      expect(d.status).toBe('SCHEDULED');
      expect(d.procedureType).toBe('FIRE_EVACUATION');
      expect(d.completedAt).toBeNull();
    });

    it('officer with saf-004:write can create', async () => {
      await grantOfficer(['saf-004:write']);
      const d = await withTestTenant(async () => drills.create(baseDrill(), officerActor()));
      expect(d.id).toBeTruthy();
    });

    it('non-manager → Forbidden', async () => {
      await expect(
        withTestTenant(async () => drills.create(baseDrill(), officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => drills.create(baseDrill(), teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => drills.create(baseDrill(), studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => drills.create(baseDrill(), parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school incidentTypeId → BadRequest', async () => {
      // Seed a school-B type
      const otherTypeId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.inc_incident_types (id, school_id, code, name, severity, is_active)
         VALUES ($1::uuid, $2::uuid, 'TST-OTHER', 'Other-only', 'LOW', true)`,
        otherTypeId,
        TEST_SCHOOL_B_ID,
      );
      try {
        await expect(
          withTestTenant(async () =>
            drills.create(baseDrill({ incidentTypeId: otherTypeId }), adminActor()),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.inc_incident_types WHERE id = $1::uuid`,
          otherTypeId,
        );
      }
    });

    it('non-existent incidentTypeId → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          drills.create(baseDrill({ incidentTypeId: generateId() }), adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('platform default incidentTypeId (school_id NULL) is accepted', async () => {
      const platformTypeId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.inc_incident_types (id, school_id, code, name, severity, is_active)
         VALUES ($1::uuid, NULL, 'TST-PLAT-DRILL', 'Platform default', 'MEDIUM', true)`,
        platformTypeId,
      );
      try {
        const d = await withTestTenant(async () =>
          drills.create(baseDrill({ incidentTypeId: platformTypeId }), adminActor()),
        );
        expect(d.incidentTypeId).toBe(platformTypeId);
      } finally {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.inc_incident_types WHERE id = $1::uuid`,
          platformTypeId,
        );
      }
    });

    describe('complete', () => {
      async function seed(): Promise<string> {
        const d = await withTestTenant(async () => drills.create(baseDrill(), adminActor()));
        return d.id;
      }

      it('SCHEDULED → COMPLETED stamps completed_at + duration + participation', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          drills.complete(
            id,
            {
              completedAt: new Date().toISOString(),
              durationSeconds: 240,
              participationRate: 0.95,
              notes: 'All evacuated in 4 minutes',
            },
            adminActor(),
          ),
        );
        expect(updated.status).toBe('COMPLETED');
        expect(updated.completedAt).toBeTruthy();
        expect(updated.durationSeconds).toBe(240);
        expect(updated.participationRate).toBe(0.95);
      });

      it('already COMPLETED → BadRequest', async () => {
        const id = await seed();
        await withTestTenant(async () =>
          drills.complete(
            id,
            { completedAt: new Date().toISOString(), durationSeconds: 100, participationRate: 1 },
            adminActor(),
          ),
        );
        await expect(
          withTestTenant(async () =>
            drills.complete(
              id,
              { completedAt: new Date().toISOString(), durationSeconds: 100, participationRate: 1 },
              adminActor(),
            ),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('missing drill → NotFound', async () => {
        await expect(
          withTestTenant(async () =>
            drills.complete(
              generateId(),
              { completedAt: new Date().toISOString(), durationSeconds: 100, participationRate: 1 },
              adminActor(),
            ),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('non-manager → Forbidden', async () => {
        const id = await seed();
        await expect(
          withTestTenant(async () =>
            drills.complete(
              id,
              { completedAt: new Date().toISOString(), durationSeconds: 100, participationRate: 1 },
              studentActor(),
            ),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    describe('cancel', () => {
      async function seed(): Promise<string> {
        const d = await withTestTenant(async () => drills.create(baseDrill(), adminActor()));
        return d.id;
      }

      it('SCHEDULED → CANCELLED', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          drills.cancel(id, { notes: 'Weather' }, adminActor()),
        );
        expect(updated.status).toBe('CANCELLED');
      });

      it('cancel after COMPLETED → BadRequest', async () => {
        const id = await seed();
        await withTestTenant(async () =>
          drills.complete(
            id,
            { completedAt: new Date().toISOString(), durationSeconds: 100, participationRate: 1 },
            adminActor(),
          ),
        );
        await expect(
          withTestTenant(async () => drills.cancel(id, { notes: 'too late' }, adminActor())),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('missing drill → NotFound', async () => {
        await expect(
          withTestTenant(async () => drills.cancel(generateId(), { notes: 'x' }, adminActor())),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('non-manager → Forbidden', async () => {
        const id = await seed();
        await expect(
          withTestTenant(async () => drills.cancel(id, { notes: 'x' }, teacherActor())),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    describe('list + overdue', () => {
      it('list returns recent drills sorted by scheduled_at DESC; filter by status', async () => {
        const a = await withTestTenant(async () =>
          drills.create(baseDrill({ procedureType: 'LOCKDOWN' }), adminActor()),
        );
        const b = await withTestTenant(async () =>
          drills.create(
            baseDrill({ procedureType: 'SHELTER_IN_PLACE' }),
            adminActor(),
          ),
        );
        await withTestTenant(async () =>
          drills.complete(
            b.id,
            { completedAt: new Date().toISOString(), durationSeconds: 100, participationRate: 1 },
            adminActor(),
          ),
        );
        const scheduled = await withTestTenant(async () => drills.list('SCHEDULED'));
        expect(scheduled.find((d) => d.id === a.id)).toBeDefined();
        expect(scheduled.find((d) => d.id === b.id)).toBeUndefined();
        const completed = await withTestTenant(async () => drills.list('COMPLETED'));
        expect(completed.find((d) => d.id === b.id)).toBeDefined();
      });

      it('overdue: never-completed regulatory types surface as overdue with 9999 days', async () => {
        const overdue = await withTestTenant(async () => drills.overdue());
        const fire = overdue.find((o) => o.procedureType === 'FIRE_EVACUATION');
        expect(fire).toBeDefined();
        expect(fire!.lastCompletedAt).toBeNull();
        expect(fire!.daysSinceLastDrill).toBe(9999);
      });

      it('overdue: a completed-91-days-ago drill still appears as overdue', async () => {
        // Insert a 91-day-old completed drill directly
        const id = generateId();
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.inc_drills
             (id, school_id, procedure_type, scheduled_at, completed_at, duration_seconds,
              participation_rate, status, created_by)
           VALUES ($1::uuid, $2::uuid, 'MEDICAL_EMERGENCY',
                   now() - INTERVAL '91 days', now() - INTERVAL '91 days',
                   60, 1.0, 'COMPLETED', $3::uuid)`,
          id,
          TEST_SCHOOL_ID,
          TEST_ADMIN_ACCOUNT_ID,
        );
        const overdue = await withTestTenant(async () => drills.overdue());
        const med = overdue.find((o) => o.procedureType === 'MEDICAL_EMERGENCY');
        expect(med).toBeDefined();
        expect(med!.daysSinceLastDrill).toBeGreaterThanOrEqual(90);
      });

      it('overdue: a recently-completed drill is NOT in the overdue list', async () => {
        // Complete a LOCKDOWN drill today
        const d = await withTestTenant(async () =>
          drills.create(baseDrill({ procedureType: 'LOCKDOWN' }), adminActor()),
        );
        await withTestTenant(async () =>
          drills.complete(
            d.id,
            { completedAt: new Date().toISOString(), durationSeconds: 60, participationRate: 1 },
            adminActor(),
          ),
        );
        const overdue = await withTestTenant(async () => drills.overdue());
        expect(overdue.find((o) => o.procedureType === 'LOCKDOWN')).toBeUndefined();
      });

      it('cross-school isolation: School B drill not visible from School A list', async () => {
        const a = await withTestTenantB(async () =>
          drills.create(baseDrill(), adminActor()),
        );
        const listA = await withTestTenant(async () => drills.list());
        expect(listA.find((d) => d.id === a.id)).toBeUndefined();
      });
    });
  });

  // ============================================================
  // IncidentTypeService
  // ============================================================
  describe('IncidentTypeService', () => {
    function baseType(overrides: Record<string, unknown> = {}) {
      return {
        code: 'TST-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        name: 'Test Type',
        severity: 'HIGH' as const,
        requiresLockdown: false,
        ...overrides,
      };
    }

    it('admin creates a school-scoped type', async () => {
      const t = await withTestTenant(async () => types.create(baseType(), adminActor()));
      expect(t.severity).toBe('HIGH');
      expect(t.schoolId).toBe(TEST_SCHOOL_ID);
      expect(t.isActive).toBe(true);
    });

    it('officer with saf-001:admin can create', async () => {
      await grantOfficer(['saf-001:admin']);
      const t = await withTestTenant(async () => types.create(baseType(), officerActor()));
      expect(t.id).toBeTruthy();
    });

    it('officer with saf-003:admin can create', async () => {
      await grantOfficer(['saf-003:admin']);
      const t = await withTestTenant(async () => types.create(baseType(), officerActor()));
      expect(t.id).toBeTruthy();
    });

    it('officer without admin permission → Forbidden', async () => {
      await expect(
        withTestTenant(async () => types.create(baseType(), officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate code in same school → BadRequest', async () => {
      const code = 'TST-DUP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      await withTestTenant(async () => types.create(baseType({ code }), adminActor()));
      await expect(
        withTestTenant(async () => types.create(baseType({ code }), adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list (default) returns active types only; includeInactive=true returns inactive too', async () => {
      const active = await withTestTenant(async () => types.create(baseType(), adminActor()));
      const inactive = await withTestTenant(async () => types.create(baseType(), adminActor()));
      await withTestTenant(async () =>
        types.patch(inactive.id, { isActive: false }, adminActor()),
      );
      const def = await withTestTenant(async () => types.list());
      expect(def.find((t) => t.id === active.id)).toBeDefined();
      expect(def.find((t) => t.id === inactive.id)).toBeUndefined();
      const all = await withTestTenant(async () => types.list(true));
      expect(all.find((t) => t.id === inactive.id)).toBeDefined();
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => types.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('patch', () => {
      async function seed(): Promise<string> {
        const t = await withTestTenant(async () => types.create(baseType(), adminActor()));
        return t.id;
      }

      it('updates name + severity + requiresLockdown + isActive', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          types.patch(
            id,
            {
              name: 'Updated Name',
              severity: 'CRITICAL',
              requiresLockdown: true,
              notificationTemplate: 'Lockdown active',
              isActive: false,
            },
            adminActor(),
          ),
        );
        expect(updated.name).toBe('Updated Name');
        expect(updated.severity).toBe('CRITICAL');
        expect(updated.requiresLockdown).toBe(true);
        expect(updated.notificationTemplate).toBe('Lockdown active');
        expect(updated.isActive).toBe(false);
      });

      it('empty patch → returns existing row unchanged', async () => {
        const id = await seed();
        const r = await withTestTenant(async () => types.patch(id, {}, adminActor()));
        expect(r.id).toBe(id);
      });

      it('platform default (school_id IS NULL) → Forbidden', async () => {
        const platformId = generateId();
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.inc_incident_types (id, school_id, code, name, severity, is_active)
           VALUES ($1::uuid, NULL, 'TST-RO', 'Read-only platform', 'LOW', true)`,
          platformId,
        );
        try {
          await expect(
            withTestTenant(async () =>
              types.patch(platformId, { name: 'try-mutate' }, adminActor()),
            ),
          ).rejects.toBeInstanceOf(ForbiddenException);
        } finally {
          await rawClient.$executeRawUnsafe(
            `DELETE FROM ${TEST_SCHEMA}.inc_incident_types WHERE id = $1::uuid`,
            platformId,
          );
        }
      });

      it('missing type → NotFound', async () => {
        await expect(
          withTestTenant(async () => types.patch(generateId(), { name: 'x' }, adminActor())),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('non-admin → Forbidden', async () => {
        const id = await seed();
        await expect(
          withTestTenant(async () => types.patch(id, { name: 'x' }, officerActor())),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  });

  // ============================================================
  // ProcedureService
  // ============================================================
  describe('ProcedureService', () => {
    function baseProc(overrides: Record<string, unknown> = {}) {
      const today = new Date().toISOString().slice(0, 10);
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      return {
        procedureType: 'FIRE_EVACUATION' as const,
        title: 'Fire Evacuation Plan v1',
        procedureSteps: [
          { stepNumber: 1, instruction: 'Activate alarm' },
          { stepNumber: 2, instruction: 'Exit via marked routes' },
        ],
        primaryContactId: TEST_ADMIN_EMPLOYEE_ID,
        externalContacts: [{ role: 'FIRE', name: 'Fire Dept', phone: '911' }],
        assemblyPoints: [{ id: 'A', name: 'Front Lawn' }],
        lastReviewedAt: today,
        reviewedBy: TEST_ADMIN_EMPLOYEE_ID,
        nextReviewDate: future,
        ...overrides,
      };
    }

    it('admin creates an emergency procedure', async () => {
      const p = await withTestTenant(async () =>
        procedures.create(baseProc(), adminActor()),
      );
      expect(p.procedureType).toBe('FIRE_EVACUATION');
      expect(p.isActive).toBe(true);
      expect(p.procedureSteps).toHaveLength(2);
    });

    it('officer with saf-001:admin can create', async () => {
      await grantOfficer(['saf-001:admin']);
      const p = await withTestTenant(async () =>
        procedures.create(baseProc({ procedureType: 'LOCKDOWN' }), officerActor()),
      );
      expect(p.id).toBeTruthy();
    });

    it('officer without admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () => procedures.create(baseProc(), officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('nextReviewDate before lastReviewedAt → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          procedures.create(
            baseProc({ lastReviewedAt: '2026-06-01', nextReviewDate: '2026-01-01' }),
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('second active procedure of same type → BadRequest (UNIQUE on type+active)', async () => {
      await withTestTenant(async () => procedures.create(baseProc(), adminActor()));
      await expect(
        withTestTenant(async () => procedures.create(baseProc(), adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list (default) returns active only; includeInactive returns inactive too', async () => {
      const p = await withTestTenant(async () =>
        procedures.create(baseProc({ procedureType: 'SHELTER_IN_PLACE' }), adminActor()),
      );
      await withTestTenant(async () =>
        procedures.patch(p.id, { isActive: false }, adminActor()),
      );
      const def = await withTestTenant(async () => procedures.list());
      expect(def.find((x) => x.id === p.id)).toBeUndefined();
      const all = await withTestTenant(async () => procedures.list(true));
      expect(all.find((x) => x.id === p.id)).toBeDefined();
    });

    it('getByType returns the active procedure for a procedure_type', async () => {
      const p = await withTestTenant(async () =>
        procedures.create(baseProc({ procedureType: 'MEDICAL_EMERGENCY' }), adminActor()),
      );
      const found = await withTestTenant(async () => procedures.getByType('MEDICAL_EMERGENCY'));
      expect(found.id).toBe(p.id);
    });

    it('getByType when none active → NotFound', async () => {
      await expect(
        withTestTenant(async () => procedures.getByType('BOMB_THREAT')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => procedures.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('loadActiveByTypeInternal returns row when active; null otherwise', async () => {
      const got = await withTestTenant(async () =>
        procedures.loadActiveByTypeInternal('HAZMAT'),
      );
      expect(got).toBeNull();
      await withTestTenant(async () =>
        procedures.create(baseProc({ procedureType: 'HAZMAT' }), adminActor()),
      );
      const found = await withTestTenant(async () =>
        procedures.loadActiveByTypeInternal('HAZMAT'),
      );
      expect(found).not.toBeNull();
    });

    describe('patch', () => {
      async function seed(): Promise<string> {
        const p = await withTestTenant(async () =>
          procedures.create(baseProc({ procedureType: 'MISSING_STUDENT' }), adminActor()),
        );
        return p.id;
      }

      it('updates title + steps + JSONB fields', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          procedures.patch(
            id,
            {
              title: 'Updated title',
              procedureSteps: [{ stepNumber: 1, instruction: 'Step one' }],
              externalContacts: [{ role: 'POLICE', name: 'Police', phone: '911' }],
              assemblyPoints: null,
            },
            adminActor(),
          ),
        );
        expect(updated.title).toBe('Updated title');
        expect(updated.procedureSteps).toHaveLength(1);
        expect(updated.assemblyPoints).toBeNull();
      });

      it('patch with effective nextReviewDate < effective lastReviewedAt → BadRequest', async () => {
        const id = await seed();
        await expect(
          withTestTenant(async () =>
            procedures.patch(id, { nextReviewDate: '2020-01-01' }, adminActor()),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('empty patch returns existing row', async () => {
        const id = await seed();
        const r = await withTestTenant(async () => procedures.patch(id, {}, adminActor()));
        expect(r.id).toBe(id);
      });

      it('updates primaryContactId / secondaryContactId / reviewedBy / s3Key', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          procedures.patch(
            id,
            {
              primaryContactId: TEST_ADMIN_EMPLOYEE_ID,
              secondaryContactId: TEST_ADMIN_EMPLOYEE_ID,
              reviewedBy: TEST_ADMIN_EMPLOYEE_ID,
              procedureDocumentS3Key: 's3://bucket/proc.pdf',
            },
            adminActor(),
          ),
        );
        expect(updated.procedureDocumentS3Key).toBe('s3://bucket/proc.pdf');
        expect(updated.secondaryContactId).toBe(TEST_ADMIN_EMPLOYEE_ID);
      });

      it('patch missing → NotFound', async () => {
        await expect(
          withTestTenant(async () =>
            procedures.patch(generateId(), { title: 'x' }, adminActor()),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('non-admin → Forbidden', async () => {
        const id = await seed();
        await expect(
          withTestTenant(async () => procedures.patch(id, { title: 'x' }, officerActor())),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('activating a second procedure of same type → BadRequest (UNIQUE)', async () => {
        const a = await seed(); // MISSING_STUDENT, active
        // Create a second one (inactive)
        const today = new Date().toISOString().slice(0, 10);
        const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        // Deactivate the first
        await withTestTenant(async () =>
          procedures.patch(a, { isActive: false }, adminActor()),
        );
        const b = await withTestTenant(async () =>
          procedures.create(baseProc({ procedureType: 'MISSING_STUDENT' }), adminActor()),
        );
        // Try to activate the first while the second is also active
        await expect(
          withTestTenant(async () =>
            procedures.patch(a, { isActive: true }, adminActor()),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        void b;
        void today;
        void future;
      });
    });

    it('cross-school isolation: School B procedure invisible from A', async () => {
      const b = await withTestTenantB(async () =>
        procedures.create(baseProc({ procedureType: 'GENERAL' }), adminActor()),
      );
      const listA = await withTestTenant(async () => procedures.list(true));
      expect(listA.find((p) => p.id === b.id)).toBeUndefined();
    });
  });
});
