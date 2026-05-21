import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  ScheduleGenerationService,
  selectSolverAlgorithm,
} from '@modules/m22-scheduling/schedule-generation.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, teacherActor, TEST_TEACHER_EMPLOYEE_ID } from '../helpers/actor';
import { TEST_SIS_ACADEMIC_YEAR_ID, TEST_SIS_CLASS_ID } from '../fixtures/sis';

/**
 * m22-scheduling ScheduleGenerationService tests — happy paths + the
 * per-branch error surfaces for the public methods. Inline stub solver
 * generates two candidates; we exercise approve/reject/resolve clash/
 * activate end-to-end against the real DB.
 */
describe('integration:m22-scheduling/schedule-generation', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let service: ScheduleGenerationService;

  // Stable infrastructure: bell schedule + periods + rooms so the
  // inline stub solver has objects to attach candidate slots to.
  let bellScheduleId: string;
  const periodIds: string[] = [];
  const roomIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    service = new ScheduleGenerationService(tenantPrisma, outbox);

    // Wipe everything we'll touch.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE source_module = 'scheduling' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_activation_log WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidate_slots WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidates WHERE request_id IN (
         SELECT id FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_constraints WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE name LIKE 'SG Test%' AND school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'SG Test%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'SG Test%'`,
    );

    bellScheduleId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
      bellScheduleId,
      TEST_SCHOOL_ID,
      'SG Test Schedule ' + Math.random().toString(36).slice(2, 6),
    );

    // Need at least 6 LESSON periods + 10 rooms for the stub solver
    // to fully build 28+2 candidate slots. We undersized to keep the
    // setup fast; the stub bails gracefully when arrays are short.
    for (let i = 0; i < 6; i++) {
      const pid = generateId();
      periodIds.push(pid);
      const startH = 8 + i;
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_periods
           (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
         VALUES ($1::uuid, $2::uuid, $3, NULL, $4::time, $5::time, 'LESSON', $6::int)`,
        pid,
        bellScheduleId,
        'P' + (i + 1),
        String(startH).padStart(2, '0') + ':00',
        String(startH).padStart(2, '0') + ':45',
        i + 1,
      );
    }

    for (let i = 0; i < 6; i++) {
      const rid = generateId();
      roomIds.push(rid);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_rooms (id, school_id, name, capacity, room_type)
         VALUES ($1::uuid, $2::uuid, $3, 30, 'CLASSROOM')`,
        rid,
        TEST_SCHOOL_ID,
        'SG Test Room ' + i,
      );
    }
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE source_module = 'scheduling' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_activation_log WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidate_slots WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidates WHERE request_id IN (
         SELECT id FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_constraints WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    if (roomIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id = ANY($1::uuid[])`,
        roomIds,
      );
    }
    if (periodIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE id = ANY($1::uuid[])`,
        periodIds,
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE id = $1::uuid`,
      bellScheduleId,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE source_module = 'scheduling' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_activation_log WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidate_slots WHERE candidate_id IN (
         SELECT c.id FROM ${TEST_SCHEMA}.sch_scheduling_candidates c
         JOIN ${TEST_SCHEMA}.sch_scheduling_requests r ON r.id = c.request_id
         WHERE r.school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_candidates WHERE request_id IN (
         SELECT id FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_scheduling_constraints WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  async function createConstraints(): Promise<string> {
    const dto = await withTestTenant(async () =>
      service.createConstraints(
        {
          name: 'Test Constraints ' + Math.random().toString(36).slice(2, 6),
          academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          hardConstraints: [{ code: 'H1', name: 'Teacher no double-book' }],
          softConstraints: [{ code: 'S1', name: 'Consecutive avoidance', weight: 1 }],
        } as any,
        adminActor(),
      ),
    );
    return dto.id;
  }

  // ────────────────────────────────────────────────────────────────────
  // Pure helper
  // ────────────────────────────────────────────────────────────────────
  describe('selectSolverAlgorithm', () => {
    it('CP_SAT when sectionCount <= 300', () => {
      expect(selectSolverAlgorithm(100)).toBe('CP_SAT');
      expect(selectSolverAlgorithm(300)).toBe('CP_SAT');
    });
    it('HEURISTIC when sectionCount > 300', () => {
      expect(selectSolverAlgorithm(301)).toBe('HEURISTIC');
      expect(selectSolverAlgorithm(5000)).toBe('HEURISTIC');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Constraints
  // ────────────────────────────────────────────────────────────────────
  describe('Scheduling constraints', () => {
    it('admin creates and lists constraints', async () => {
      const id = await createConstraints();
      const list = await withTestTenant(async () => service.listConstraints());
      expect(list.map((c) => c.id)).toContain(id);
    });

    it('non-admin createConstraints → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.createConstraints(
            {
              name: 'X',
              hardConstraints: [],
              softConstraints: [],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate (school, year, name) → ConflictException', async () => {
      const name = 'Dup ' + Math.random().toString(36).slice(2, 6);
      await withTestTenant(async () =>
        service.createConstraints(
          {
            name,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            hardConstraints: [],
            softConstraints: [],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.createConstraints(
            {
              name,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              hardConstraints: [],
              softConstraints: [],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // submitRequest happy path + lifecycle
  // ────────────────────────────────────────────────────────────────────
  describe('submitRequest', () => {
    it('admin submits → request COMPLETED, 2 candidates emitted', async () => {
      const constraintId = await createConstraints();
      const dto = await withTestTenant(async () =>
        service.submitRequest({ constraintId, sectionCount: 50 } as any, adminActor()),
      );
      expect(dto.status).toBe('COMPLETED');
      expect(dto.candidatesGenerated).toBe(2);
      expect(dto.candidates?.length).toBe(2);

      // Outbox row landed for sch.generation.completed
      const outboxRows = (await rawClient.$queryRawUnsafe(
        `SELECT id, topic FROM platform.platform_outbox WHERE message_key = $1::text`,
        dto.id,
      )) as Array<{ id: string; topic: string }>;
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0]!.topic).toBe('sch.generation.completed');
    });

    it('non-admin → ForbiddenException', async () => {
      const constraintId = await createConstraints();
      await expect(
        withTestTenant(async () =>
          service.submitRequest({ constraintId, sectionCount: 50 } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('CP_SAT with sectionCount > 300 → BadRequest', async () => {
      const constraintId = await createConstraints();
      await expect(
        withTestTenant(async () =>
          service.submitRequest(
            {
              constraintId,
              sectionCount: 500,
              solverAlgorithm: 'CP_SAT',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listRequests + getRequest return the queued request', async () => {
      const constraintId = await createConstraints();
      const dto = await withTestTenant(async () =>
        service.submitRequest({ constraintId, sectionCount: 50 } as any, adminActor()),
      );
      const list = await withTestTenant(async () => service.listRequests({} as any));
      expect(list.map((r) => r.id)).toContain(dto.id);

      const got = await withTestTenant(async () => service.getRequest(dto.id));
      expect(got.id).toBe(dto.id);
      expect(got.candidates?.length).toBe(2);
    });

    it('getRequest unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getRequest('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Candidate review + activation
  // ────────────────────────────────────────────────────────────────────
  describe('Candidate review + activation', () => {
    async function submitAndGetCandidates(): Promise<{
      requestId: string;
      cleanCandidateId: string;
      dirtyCandidateId: string;
    }> {
      const constraintId = await createConstraints();
      const req = await withTestTenant(async () =>
        service.submitRequest({ constraintId, sectionCount: 50 } as any, adminActor()),
      );
      // Candidate A is the clean one (totalClashes=0), B has 2 clashes.
      const clean = req.candidates!.find((c) => c.totalClashes === 0)!;
      const dirty = req.candidates!.find((c) => c.totalClashes > 0)!;
      return {
        requestId: req.id,
        cleanCandidateId: clean.id,
        dirtyCandidateId: dirty.id,
      };
    }

    it('admin approves PENDING candidate', async () => {
      const { cleanCandidateId } = await submitAndGetCandidates();
      const dto = await withTestTenant(async () =>
        service.approveCandidate(
          cleanCandidateId,
          { reviewNotes: 'looks good' } as any,
          adminActor(),
        ),
      );
      expect(dto.reviewStatus).toBe('APPROVED');
      expect(dto.reviewNotes).toBe('looks good');
    });

    it('admin rejects PENDING candidate', async () => {
      const { dirtyCandidateId } = await submitAndGetCandidates();
      const dto = await withTestTenant(async () =>
        service.rejectCandidate(
          dirtyCandidateId,
          { reviewNotes: 'too many clashes' } as any,
          adminActor(),
        ),
      );
      expect(dto.reviewStatus).toBe('REJECTED');
    });

    it('approve unknown candidate → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.approveCandidate('00000000-0000-0000-0000-000000000000', {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin approve → ForbiddenException', async () => {
      const { cleanCandidateId } = await submitAndGetCandidates();
      await expect(
        withTestTenant(async () =>
          service.approveCandidate(cleanCandidateId, {} as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('approving an already-APPROVED candidate → ConflictException', async () => {
      const { cleanCandidateId } = await submitAndGetCandidates();
      await withTestTenant(async () =>
        service.approveCandidate(cleanCandidateId, {} as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          service.approveCandidate(cleanCandidateId, {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('getCandidate cross-school → NotFoundException', async () => {
      const { cleanCandidateId } = await submitAndGetCandidates();
      await expect(
        withTestTenantB(async () => service.getCandidate(cleanCandidateId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listCandidateSlots returns slots for the candidate', async () => {
      const { cleanCandidateId } = await submitAndGetCandidates();
      const slots = await withTestTenant(async () => service.listCandidateSlots(cleanCandidateId));
      expect(slots.length).toBeGreaterThan(0);
    });

    it('resolveClash clears a clash flag', async () => {
      const { dirtyCandidateId } = await submitAndGetCandidates();
      const slots = await withTestTenant(async () => service.listCandidateSlots(dirtyCandidateId));
      const flagged = slots.find((s) => s.hasClash === true)!;
      const updated = await withTestTenant(async () =>
        service.resolveClash(dirtyCandidateId, { slotId: flagged.id } as any, adminActor()),
      );
      expect(updated.hasClash).toBe(false);
      expect(updated.clashDescription).toBeNull();
    });

    it('resolveClash sets new description', async () => {
      const { dirtyCandidateId } = await submitAndGetCandidates();
      const slots = await withTestTenant(async () => service.listCandidateSlots(dirtyCandidateId));
      const flagged = slots.find((s) => s.hasClash === true)!;
      const updated = await withTestTenant(async () =>
        service.resolveClash(
          dirtyCandidateId,
          { slotId: flagged.id, clashDescription: 'override' } as any,
          adminActor(),
        ),
      );
      expect(updated.hasClash).toBe(true);
      expect(updated.clashDescription).toBe('override');
    });

    it('resolveClash unknown slot → NotFoundException', async () => {
      const { cleanCandidateId } = await submitAndGetCandidates();
      await expect(
        withTestTenant(async () =>
          service.resolveClash(
            cleanCandidateId,
            { slotId: '00000000-0000-0000-0000-000000000000' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin resolveClash → ForbiddenException', async () => {
      const { dirtyCandidateId } = await submitAndGetCandidates();
      const slots = await withTestTenant(async () => service.listCandidateSlots(dirtyCandidateId));
      const flagged = slots.find((s) => s.hasClash === true)!;
      await expect(
        withTestTenant(async () =>
          service.resolveClash(dirtyCandidateId, { slotId: flagged.id } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('activate APPROVED clean candidate → slots promoted', async () => {
      const { cleanCandidateId } = await submitAndGetCandidates();
      await withTestTenant(async () =>
        service.approveCandidate(cleanCandidateId, {} as any, adminActor()),
      );
      const result = await withTestTenant(async () =>
        service.activateCandidate(cleanCandidateId, adminActor()),
      );
      expect(result.candidateId).toBe(cleanCandidateId);
      // The stub builds candidate slots with classId pointing to
      // sis_classes that exist (TEST_SIS_CLASS_ID among them), so at
      // least some slots should promote. The exact split depends on
      // how many classes the stub picked up.
      expect(result.slotsPromoted + result.slotsSkipped).toBeGreaterThan(0);
      expect(result.activationLogId).toBeTruthy();
    });

    it('activate non-APPROVED → ConflictException', async () => {
      const { cleanCandidateId } = await submitAndGetCandidates();
      await expect(
        withTestTenant(async () => service.activateCandidate(cleanCandidateId, adminActor())),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('activate candidate with flagged clashes → ConflictException', async () => {
      const { dirtyCandidateId } = await submitAndGetCandidates();
      // Approve the dirty one anyway and try to activate — clash count
      // and has_clash rows refuse promotion.
      await withTestTenant(async () =>
        service.approveCandidate(dirtyCandidateId, {} as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => service.activateCandidate(dirtyCandidateId, adminActor())),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-admin activate → ForbiddenException', async () => {
      const { cleanCandidateId } = await submitAndGetCandidates();
      await expect(
        withTestTenant(async () => service.activateCandidate(cleanCandidateId, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('activate unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.activateCandidate('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listActivationLogs returns activation row after activation', async () => {
      const { cleanCandidateId } = await submitAndGetCandidates();
      await withTestTenant(async () =>
        service.approveCandidate(cleanCandidateId, {} as any, adminActor()),
      );
      await withTestTenant(async () => service.activateCandidate(cleanCandidateId, adminActor()));
      const logs = await withTestTenant(async () => service.listActivationLogs(cleanCandidateId));
      expect(logs.length).toBe(1);
      expect(logs[0]!.candidateId).toBe(cleanCandidateId);
    });
  });
});
