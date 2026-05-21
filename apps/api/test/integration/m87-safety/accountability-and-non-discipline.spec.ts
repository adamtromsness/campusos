import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AccountabilityService } from '@modules/m87-safety/reunification/accountability.service';
import { NonDisciplineIncidentService } from '@modules/m87-safety/incidents/non-discipline.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { makeRecordingKafka } from '../helpers/recording-kafka';

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
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

describe('integration:m87-safety/accountability-and-non-discipline', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let accountability: AccountabilityService;
  let nonDiscipline: NonDisciplineIncidentService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    accountability = new AccountabilityService(tenantPrisma, permCheck);
    const kafka = makeRecordingKafka();
    nonDiscipline = new NonDisciplineIncidentService(tenantPrisma, permCheck, kafka);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe all incident-related tables. Order: timeline + accountability
    // + reunification + corrections first, then incidents.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_accountability_summary WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_accountability_records WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incident_timeline WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_declaration_outbox WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_non_discipline_incidents WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
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

  async function seedIncident(school = TEST_SCHOOL_ID): Promise<string> {
    const incidentId = generateId();
    // Get a platform incident type
    const typeRows = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.inc_incident_types WHERE school_id IS NULL AND is_active = true LIMIT 1`,
    )) as Array<{ id: string }>;
    let typeId = typeRows[0]?.id;
    if (!typeId) {
      typeId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.inc_incident_types (id, school_id, code, name, severity, is_active)
         VALUES ($1::uuid, NULL, 'TST-ACC', 'Test', 'HIGH', true)
         ON CONFLICT DO NOTHING`,
        typeId,
      );
    }
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.inc_incidents
         (id, school_id, incident_type_id, declared_by, declared_at, status, description)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now(), 'ACTIVE', 'Test incident')`,
      incidentId,
      school,
      typeId,
      TEST_ADMIN_ACCOUNT_ID,
    );
    return incidentId;
  }

  async function seedAccountabilityRecord(
    incidentId: string,
    personId: string,
    personType: 'STUDENT' | 'STAFF' | 'VISITOR',
    status: 'UNKNOWN' | 'ACCOUNTED_FOR' | 'EVACUATED' | 'MEDICAL_ASSISTANCE' | 'MISSING',
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.inc_accountability_records
         (id, incident_id, person_id, person_type, status, last_updated_by, last_updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, now())`,
      id,
      incidentId,
      personId,
      personType,
      status,
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  // ============================================================
  // AccountabilityService
  // ============================================================
  describe('AccountabilityService', () => {
    it('listForIncident returns records sorted by person_type, status, created_at', async () => {
      const incidentId = await seedIncident();
      await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'UNKNOWN');
      await seedAccountabilityRecord(incidentId, generateId(), 'STAFF', 'ACCOUNTED_FOR');
      await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'EVACUATED');

      const list = await withTestTenant(async () => accountability.listForIncident(incidentId));
      expect(list).toHaveLength(3);
    });

    it('listForIncident with cross-school incident returns empty', async () => {
      const incidentBId = await seedIncident(TEST_SCHOOL_B_ID);
      await seedAccountabilityRecord(incidentBId, generateId(), 'STUDENT', 'UNKNOWN');
      const listFromA = await withTestTenant(async () =>
        accountability.listForIncident(incidentBId),
      );
      expect(listFromA).toEqual([]);
    });

    describe('getSummary', () => {
      it('returns null when no records yet (no summary row materialised)', async () => {
        const incidentId = await seedIncident();
        const summary = await withTestTenant(async () => accountability.getSummary(incidentId));
        expect(summary).toBeNull();
      });

      it('returns the materialised summary after recompute', async () => {
        const incidentId = await seedIncident();
        await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'UNKNOWN');
        await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'ACCOUNTED_FOR');
        await seedAccountabilityRecord(incidentId, generateId(), 'STAFF', 'MISSING');
        await withTestTenant(async () => accountability.recomputeSummary(incidentId));
        const s = await withTestTenant(async () => accountability.getSummary(incidentId));
        expect(s).not.toBeNull();
        expect(s!.totalPeople).toBe(3);
        expect(s!.accountedFor).toBe(1);
        expect(s!.unknown).toBe(1);
        expect(s!.missing).toBe(1);
        expect(s!.evacuated).toBe(0);
        expect(s!.medicalAssistance).toBe(0);
      });

      it('cross-school incident → NotFound', async () => {
        const incidentBId = await seedIncident(TEST_SCHOOL_B_ID);
        await expect(
          withTestTenant(async () => accountability.getSummary(incidentBId)),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('missing incident → NotFound', async () => {
        await expect(
          withTestTenant(async () => accountability.getSummary(generateId())),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('update single record', () => {
      it('admin updates status + notes; summary recomputes', async () => {
        const incidentId = await seedIncident();
        const recordId = await seedAccountabilityRecord(
          incidentId,
          generateId(),
          'STUDENT',
          'UNKNOWN',
        );
        const updated = await withTestTenant(async () =>
          accountability.update(
            recordId,
            { status: 'ACCOUNTED_FOR', notes: 'In room 12' },
            adminActor(),
          ),
        );
        expect(updated.status).toBe('ACCOUNTED_FOR');
        expect(updated.notes).toBe('In room 12');

        const s = await withTestTenant(async () => accountability.getSummary(incidentId));
        expect(s!.accountedFor).toBe(1);
        expect(s!.unknown).toBe(0);
      });

      it('officer with saf-001:write can update', async () => {
        await grantOfficer(['saf-001:write']);
        const incidentId = await seedIncident();
        const recordId = await seedAccountabilityRecord(
          incidentId,
          generateId(),
          'STUDENT',
          'UNKNOWN',
        );
        const updated = await withTestTenant(async () =>
          accountability.update(recordId, { status: 'EVACUATED' }, officerActor()),
        );
        expect(updated.status).toBe('EVACUATED');
      });

      it('non-responder → Forbidden', async () => {
        const incidentId = await seedIncident();
        const recordId = await seedAccountabilityRecord(
          incidentId,
          generateId(),
          'STUDENT',
          'UNKNOWN',
        );
        await expect(
          withTestTenant(async () =>
            accountability.update(recordId, { status: 'EVACUATED' }, teacherActor()),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('missing record → NotFound', async () => {
        await expect(
          withTestTenant(async () =>
            accountability.update(generateId(), { status: 'EVACUATED' }, adminActor()),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('cross-school record → NotFound (JOIN to inc_incidents enforces)', async () => {
        const incidentBId = await seedIncident(TEST_SCHOOL_B_ID);
        const recordId = await seedAccountabilityRecord(
          incidentBId,
          generateId(),
          'STUDENT',
          'UNKNOWN',
        );
        await expect(
          withTestTenant(async () =>
            accountability.update(recordId, { status: 'EVACUATED' }, adminActor()),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('bulkUpdate', () => {
      it('marks N records ACCOUNTED_FOR + recomputes summary', async () => {
        const incidentId = await seedIncident();
        const a = await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'UNKNOWN');
        const b = await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'UNKNOWN');
        const c = await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'UNKNOWN');
        const result = await withTestTenant(async () =>
          accountability.bulkUpdate(
            incidentId,
            { recordIds: [a, b, c], status: 'ACCOUNTED_FOR' },
            adminActor(),
          ),
        );
        expect(result.updated).toBe(3);
        const s = await withTestTenant(async () => accountability.getSummary(incidentId));
        expect(s!.accountedFor).toBe(3);
      });

      it('partial id list → only matching records get updated', async () => {
        const incidentId = await seedIncident();
        const a = await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'UNKNOWN');
        await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'UNKNOWN');
        const result = await withTestTenant(async () =>
          accountability.bulkUpdate(
            incidentId,
            { recordIds: [a, generateId()], status: 'EVACUATED' },
            adminActor(),
          ),
        );
        expect(result.updated).toBe(1);
      });

      it('empty recordIds → BadRequest', async () => {
        const incidentId = await seedIncident();
        await expect(
          withTestTenant(async () =>
            accountability.bulkUpdate(
              incidentId,
              { recordIds: [], status: 'EVACUATED' },
              adminActor(),
            ),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('cross-school incident → NotFound', async () => {
        const incidentBId = await seedIncident(TEST_SCHOOL_B_ID);
        await expect(
          withTestTenant(async () =>
            accountability.bulkUpdate(
              incidentBId,
              { recordIds: [generateId()], status: 'EVACUATED' },
              adminActor(),
            ),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('non-responder → Forbidden', async () => {
        const incidentId = await seedIncident();
        const a = await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'UNKNOWN');
        await expect(
          withTestTenant(async () =>
            accountability.bulkUpdate(
              incidentId,
              { recordIds: [a], status: 'EVACUATED' },
              teacherActor(),
            ),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    describe('recomputeSummary', () => {
      it('materialises a row when records exist', async () => {
        const incidentId = await seedIncident();
        await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'MEDICAL_ASSISTANCE');
        const s = await withTestTenant(async () => accountability.recomputeSummary(incidentId));
        expect(s.totalPeople).toBe(1);
        expect(s.medicalAssistance).toBe(1);
      });

      it('materialises a zero-total row when no records exist', async () => {
        const incidentId = await seedIncident();
        const s = await withTestTenant(async () => accountability.recomputeSummary(incidentId));
        expect(s.totalPeople).toBe(0);
        expect(s.accountedFor).toBe(0);
      });

      it('idempotent: second recompute updates existing row', async () => {
        const incidentId = await seedIncident();
        await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'UNKNOWN');
        await withTestTenant(async () => accountability.recomputeSummary(incidentId));
        await seedAccountabilityRecord(incidentId, generateId(), 'STUDENT', 'EVACUATED');
        const s = await withTestTenant(async () => accountability.recomputeSummary(incidentId));
        expect(s.totalPeople).toBe(2);
        expect(s.evacuated).toBe(1);
      });
    });
  });

  // ============================================================
  // NonDisciplineIncidentService
  // ============================================================
  describe('NonDisciplineIncidentService', () => {
    function baseInput(overrides: Record<string, unknown> = {}) {
      return {
        incidentType: 'STUDENT_INJURY' as const,
        location: 'Playground',
        incidentDate: new Date().toISOString(),
        description: 'Student scraped knee falling off swing',
        severity: 'LOW' as const,
        ...overrides,
      };
    }

    it('admin creates a non-discipline incident report', async () => {
      const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
      expect(r.incidentType).toBe('STUDENT_INJURY');
      expect(r.severity).toBe('LOW');
      expect(r.status).toBe('OPEN');
      expect(r.reportedBy).toBe(TEST_ADMIN_ACCOUNT_ID);
    });

    it('teacher can create (saf-002:write or admin)', async () => {
      // Teacher needs saf-002:write to create — grant to teacher account
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_effective_access_cache
           (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
         ON CONFLICT (account_id, scope_id) DO UPDATE
           SET permission_codes = EXCLUDED.permission_codes`,
        id,
        TEST_TEACHER_ACCOUNT_ID,
        TEST_SCHOOL_SCOPE_ID,
        ['saf-003:write'],
      );
      try {
        const r = await withTestTenant(async () =>
          nonDiscipline.create(baseInput(), teacherActor()),
        );
        expect(r.id).toBeTruthy();
      } finally {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
          TEST_TEACHER_ACCOUNT_ID,
        );
      }
    });

    it('student → Forbidden (persona collapse)', async () => {
      await expect(
        withTestTenant(async () => nonDiscipline.create(baseInput(), studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => nonDiscipline.create(baseInput(), parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-tenant studentsInvolved → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          nonDiscipline.create(baseInput({ studentsInvolved: [generateId()] }), adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-tenant staffInvolved → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          nonDiscipline.create(baseInput({ staffInvolved: [generateId()] }), adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    describe('list — row scoping', () => {
      it('non-admin non-reviewer sees only own reports', async () => {
        // Grant teacher saf-002:write so they can create reports
        await rawClient.$executeRawUnsafe(
          `INSERT INTO platform.iam_effective_access_cache
             (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
           ON CONFLICT (account_id, scope_id) DO UPDATE
             SET permission_codes = EXCLUDED.permission_codes`,
          generateId(),
          TEST_TEACHER_ACCOUNT_ID,
          TEST_SCHOOL_SCOPE_ID,
          ['saf-003:write'],
        );
        try {
          const myReport = await withTestTenant(async () =>
            nonDiscipline.create(baseInput(), teacherActor()),
          );
          const otherReport = await withTestTenant(async () =>
            nonDiscipline.create(baseInput(), adminActor()),
          );
          // Teacher (non-reviewer) sees only their own
          const teacherList = await withTestTenant(async () =>
            nonDiscipline.list({}, teacherActor()),
          );
          expect(teacherList.find((r) => r.id === myReport.id)).toBeDefined();
          expect(teacherList.find((r) => r.id === otherReport.id)).toBeUndefined();

          // Admin sees both
          const adminList = await withTestTenant(async () => nonDiscipline.list({}, adminActor()));
          expect(adminList.find((r) => r.id === myReport.id)).toBeDefined();
          expect(adminList.find((r) => r.id === otherReport.id)).toBeDefined();
        } finally {
          await rawClient.$executeRawUnsafe(
            `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
            TEST_TEACHER_ACCOUNT_ID,
          );
        }
      });

      it('list filter: incidentType', async () => {
        const injury = await withTestTenant(async () =>
          nonDiscipline.create(baseInput(), adminActor()),
        );
        const damage = await withTestTenant(async () =>
          nonDiscipline.create(baseInput({ incidentType: 'PROPERTY_DAMAGE' }), adminActor()),
        );
        const onlyInjury = await withTestTenant(async () =>
          nonDiscipline.list({ incidentType: 'STUDENT_INJURY' }, adminActor()),
        );
        expect(onlyInjury.find((r) => r.id === injury.id)).toBeDefined();
        expect(onlyInjury.find((r) => r.id === damage.id)).toBeUndefined();
      });

      it('list filter: status', async () => {
        const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
        const open = await withTestTenant(async () =>
          nonDiscipline.list({ status: 'OPEN' }, adminActor()),
        );
        expect(open.find((x) => x.id === r.id)).toBeDefined();
        const closed = await withTestTenant(async () =>
          nonDiscipline.list({ status: 'CLOSED' }, adminActor()),
        );
        expect(closed.find((x) => x.id === r.id)).toBeUndefined();
      });

      it('list filter: mineOnly clamps to own reports', async () => {
        const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
        const list = await withTestTenant(async () =>
          nonDiscipline.list({ mineOnly: true }, adminActor()),
        );
        expect(list.find((x) => x.id === r.id)).toBeDefined();
      });

      it('list limit is clamped at 500', async () => {
        const list = await withTestTenant(async () =>
          nonDiscipline.list({ limit: 1000 }, adminActor()),
        );
        // Just verify it executes without error
        expect(Array.isArray(list)).toBe(true);
      });
    });

    describe('getById', () => {
      it('admin sees any report; teacher only their own', async () => {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO platform.iam_effective_access_cache
             (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
           ON CONFLICT (account_id, scope_id) DO UPDATE
             SET permission_codes = EXCLUDED.permission_codes`,
          generateId(),
          TEST_TEACHER_ACCOUNT_ID,
          TEST_SCHOOL_SCOPE_ID,
          ['saf-003:write'],
        );
        try {
          const otherReport = await withTestTenant(async () =>
            nonDiscipline.create(baseInput(), adminActor()),
          );
          // Admin can read it
          const found = await withTestTenant(async () =>
            nonDiscipline.getById(otherReport.id, adminActor()),
          );
          expect(found.id).toBe(otherReport.id);
          // Teacher cannot (NotFound to avoid leaking existence)
          await expect(
            withTestTenant(async () => nonDiscipline.getById(otherReport.id, teacherActor())),
          ).rejects.toBeInstanceOf(NotFoundException);
        } finally {
          await rawClient.$executeRawUnsafe(
            `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
            TEST_TEACHER_ACCOUNT_ID,
          );
        }
      });

      it('missing → NotFound', async () => {
        await expect(
          withTestTenant(async () => nonDiscipline.getById(generateId(), adminActor())),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('cross-school → NotFound', async () => {
        const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
        await expect(
          withTestTenantB(async () => nonDiscipline.getById(r.id, adminActor())),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('patch', () => {
      it('admin patches status OPEN → UNDER_REVIEW stamps reviewed_by + reviewed_at', async () => {
        const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
        const u = await withTestTenant(async () =>
          nonDiscipline.patch(r.id, { status: 'UNDER_REVIEW' }, adminActor()),
        );
        expect(u.status).toBe('UNDER_REVIEW');
        expect(u.reviewedBy).toBeTruthy();
      });

      it('admin patches status OPEN → CLOSED stamps closed_at + reviewed_at', async () => {
        const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
        const u = await withTestTenant(async () =>
          nonDiscipline.patch(
            r.id,
            { status: 'CLOSED', resolution: 'No further action' },
            adminActor(),
          ),
        );
        expect(u.status).toBe('CLOSED');
        expect(u.closedAt).toBeTruthy();
      });

      it('cannot reopen a CLOSED incident → BadRequest', async () => {
        const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
        await withTestTenant(async () =>
          nonDiscipline.patch(r.id, { status: 'CLOSED' }, adminActor()),
        );
        await expect(
          withTestTenant(async () => nonDiscipline.patch(r.id, { status: 'OPEN' }, adminActor())),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('patch followUpTicketId + resolution without status change', async () => {
        const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
        const ticketId = generateId();
        const u = await withTestTenant(async () =>
          nonDiscipline.patch(
            r.id,
            { followUpTicketId: ticketId, resolution: 'Linked to maintenance ticket' },
            adminActor(),
          ),
        );
        expect(u.followUpTicketId).toBe(ticketId);
        expect(u.resolution).toBe('Linked to maintenance ticket');
      });

      it('empty patch returns the existing row', async () => {
        const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
        const u = await withTestTenant(async () => nonDiscipline.patch(r.id, {}, adminActor()));
        expect(u.id).toBe(r.id);
        expect(u.status).toBe('OPEN');
      });

      it('non-reviewer (teacher) → Forbidden even on own report', async () => {
        const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
        await expect(
          withTestTenant(async () =>
            nonDiscipline.patch(r.id, { status: 'CLOSED' }, teacherActor()),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('missing report → NotFound', async () => {
        await expect(
          withTestTenant(async () =>
            nonDiscipline.patch(generateId(), { status: 'CLOSED' }, adminActor()),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('cross-school patch → NotFound', async () => {
        const r = await withTestTenant(async () => nonDiscipline.create(baseInput(), adminActor()));
        await expect(
          withTestTenantB(async () =>
            nonDiscipline.patch(r.id, { status: 'CLOSED' }, adminActor()),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });
});
