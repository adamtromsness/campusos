import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ChildLinkRequestService } from '@modules/m20-sis/guardians/child-link-request.service';
import { ParentUpdateService } from '@modules/m20-sis/guardians/parent-update.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID, TEST_SCHOOL_B_SCOPE_ID } from '../fixtures/platform';
import {
  seedStudent,
  seedGuardian,
  linkStudentGuardian,
  cleanupSeededIds,
  ensureGuardianForPerson,
} from './sis-helpers';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';

/**
 * Wave 4 — m20-sis ChildLinkRequestService + ParentUpdateService
 *
 * Contracts:
 *   - GUARDIAN-only submitLinkExisting / submitAddNew
 *   - Admin-only approve / reject
 *   - Partial-UNIQUE pending dedup (LINK_EXISTING + ADD_NEW)
 *   - approve: LINK_EXISTING writes sis_student_guardians link;
 *     ADD_NEW creates iam_person + platform_students + sis_students + link
 *   - reject: terminal status; no link writes
 *   - searchExistingStudents → DOB + names matched against iam_person
 *   - ParentUpdateService: shouldAutoApprove drives AUTO_APPROVED vs PENDING
 *   - Outbox emit on submit + review (durable in same tx)
 *   - Cross-school isolation: STUDENT_INFO / GUARDIAN_INFO / EMERGENCY_CONTACT
 *     reject when target lives in another school
 */
describe('integration:m20-sis/guardians', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let kafka: RecordingKafkaProducer;
  let outbox: OutboxService;
  let childLinkService: ChildLinkRequestService;
  let parentUpdateService: ParentUpdateService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    kafka = makeRecordingKafka();
    outbox = new OutboxService();
    childLinkService = new ChildLinkRequestService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
    parentUpdateService = new ParentUpdateService(tenantPrisma, permCheck, outbox);
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id IN ($1::uuid, $2::uuid)`,
      TEST_PARENT_ACCOUNT_ID,
      TEST_ADMIN_ACCOUNT_ID,
    );
    // Drop stable-actor guardian rows + any links so a following spec
    // sees a clean slate for TEST_PARENT_PERSON_ID.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE guardian_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid)`,
      TEST_PARENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid`,
      TEST_PARENT_PERSON_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    kafka.reset();
    // Wipe state for both services
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_child_link_requests`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_parent_info_update_requests`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_auto_approval_rules`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic LIKE 'sis.parent_update.%' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_emergency_contacts`,
    );
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function trackedGuardian(opts: Parameters<typeof seedGuardian>[1] = {}) {
    const g = await seedGuardian(rawClient, opts);
    guardianIds.push(g.guardianId);
    personIds.push(g.personId);
    accountIds.push(g.accountId);
    return g;
  }

  async function ensureParentGuardian(schoolId: string = TEST_SCHOOL_ID): Promise<string> {
    const gid = await ensureGuardianForPerson(
      rawClient,
      TEST_PARENT_PERSON_ID,
      TEST_PARENT_ACCOUNT_ID,
      schoolId,
    );
    guardianIds.push(gid);
    return gid;
  }

  // ============================================================
  // ChildLinkRequestService
  // ============================================================
  describe('ChildLinkRequestService.searchExistingStudents', () => {
    it('GUARDIAN search by exact name + DOB returns matches', async () => {
      const personId = generateId();
      const platformStudentId = generateId();
      const studentId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, date_of_birth, is_active)
         VALUES ($1::uuid, 'Lily', 'Smith', 'STUDENT', '2015-06-15'::date, true)`,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Lily', 'Smith', true)`,
        platformStudentId,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'SR-LILY', '4', 'ENROLLED')`,
        studentId,
        platformStudentId,
        TEST_SCHOOL_ID,
      );
      studentIds.push(studentId);
      platformStudentIds.push(platformStudentId);
      personIds.push(personId);

      await ensureParentGuardian();
      const results = await withTestTenant(async () =>
        childLinkService.searchExistingStudents('LILY', 'smith', '2015-06-15', parentActor()),
      );
      const names = results.map((r) => r.studentId);
      expect(names).toContain(studentId);
    });

    it('non-guardian non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          childLinkService.searchExistingStudents('A', 'B', '2015-06-15', teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin search succeeds (admin bypasses GUARDIAN gate)', async () => {
      const results = await withTestTenant(async () =>
        childLinkService.searchExistingStudents('NoOne', 'Else', '2015-06-15', adminActor()),
      );
      expect(Array.isArray(results)).toBe(true);
    });

    it('missing dateOfBirth → BadRequestException', async () => {
      await ensureParentGuardian();
      await expect(
        withTestTenant(async () =>
          childLinkService.searchExistingStudents('A', 'B', '', parentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('ChildLinkRequestService.submitLinkExisting', () => {
    it('parent submits LINK_EXISTING → PENDING row created', async () => {
      const child = await trackedStudent({ firstName: 'Pre', lastName: 'Existing' });
      await ensureParentGuardian();
      const req = await withTestTenant(async () =>
        childLinkService.submitLinkExisting(child.studentId, parentActor()),
      );
      expect(req.requestType).toBe('LINK_EXISTING');
      expect(req.existingStudentId).toBe(child.studentId);
      expect(req.status).toBe('PENDING');
    });

    it('non-GUARDIAN → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          childLinkService.submitLinkExisting(generateId(), adminActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('GUARDIAN with no sis_guardians row in this school → NotFoundException', async () => {
      // No ensureParentGuardian call — the parent has no guardian row in this school.
      await expect(
        withTestTenant(async () =>
          childLinkService.submitLinkExisting(generateId(), parentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Submit on non-existent studentId → NotFoundException', async () => {
      await ensureParentGuardian();
      await expect(
        withTestTenant(async () =>
          childLinkService.submitLinkExisting(generateId(), parentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Already linked → ConflictException', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      await expect(
        withTestTenant(async () =>
          childLinkService.submitLinkExisting(child.studentId, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('Duplicate PENDING request → ConflictException', async () => {
      const child = await trackedStudent();
      await ensureParentGuardian();
      await withTestTenant(async () =>
        childLinkService.submitLinkExisting(child.studentId, parentActor()),
      );
      await expect(
        withTestTenant(async () =>
          childLinkService.submitLinkExisting(child.studentId, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('ChildLinkRequestService.submitAddNew', () => {
    it('parent submits ADD_NEW → PENDING row populated with new_child_* fields', async () => {
      await ensureParentGuardian();
      const req = await withTestTenant(async () =>
        childLinkService.submitAddNew(
          {
            firstName: 'NewKid',
            lastName: 'NewLast',
            dateOfBirth: '2017-03-01',
            gradeLevel: '2',
          },
          parentActor(),
        ),
      );
      expect(req.requestType).toBe('ADD_NEW');
      expect(req.newChildFirstName).toBe('NewKid');
      expect(req.newChildLastName).toBe('NewLast');
      expect(req.status).toBe('PENDING');
    });

    it('Duplicate ADD_NEW request (case-insensitive names + same DOB) → ConflictException', async () => {
      await ensureParentGuardian();
      await withTestTenant(async () =>
        childLinkService.submitAddNew(
          { firstName: 'Lily', lastName: 'Smith', dateOfBirth: '2018-04-04', gradeLevel: '1' },
          parentActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          childLinkService.submitAddNew(
            { firstName: 'LILY', lastName: 'smith', dateOfBirth: '2018-04-04', gradeLevel: '1' },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('ChildLinkRequestService.list / getById', () => {
    it('parent only sees own requests', async () => {
      const child = await trackedStudent();
      await ensureParentGuardian();
      const req = await withTestTenant(async () =>
        childLinkService.submitLinkExisting(child.studentId, parentActor()),
      );
      // Another guardian's request
      const otherG = await trackedGuardian();
      const otherChild = await trackedStudent({ firstName: 'Other', lastName: 'Kid' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_child_link_requests
           (id, school_id, requesting_guardian_id, request_type, existing_student_id, status)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'LINK_EXISTING', $3::uuid, 'PENDING')`,
        TEST_SCHOOL_ID,
        otherG.guardianId,
        otherChild.studentId,
      );

      const list = await withTestTenant(async () =>
        childLinkService.list({}, parentActor()),
      );
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(req.id);
    });

    it('admin sees all and can filter by status', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await withTestTenant(async () =>
        childLinkService.submitLinkExisting(child.studentId, parentActor()),
      );
      const list = await withTestTenant(async () =>
        childLinkService.list({ status: 'PENDING' }, adminActor()),
      );
      expect(list.map((r) => r.requestingGuardianId)).toContain(guardianId);
      const noneRejected = await withTestTenant(async () =>
        childLinkService.list({ status: 'REJECTED' }, adminActor()),
      );
      expect(noneRejected).toHaveLength(0);
    });

    it('parent cannot getById someone else\'s request → 404', async () => {
      const otherG = await trackedGuardian();
      const otherChild = await trackedStudent();
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_child_link_requests
           (id, school_id, requesting_guardian_id, request_type, existing_student_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'LINK_EXISTING', $4::uuid, 'PENDING')`,
        id,
        TEST_SCHOOL_ID,
        otherG.guardianId,
        otherChild.studentId,
      );
      await ensureParentGuardian();
      await expect(
        withTestTenant(async () => childLinkService.getById(id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ChildLinkRequestService.approve', () => {
    it('admin approves LINK_EXISTING → sis_student_guardians link created + status APPROVED', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      const req = await withTestTenant(async () =>
        childLinkService.submitLinkExisting(child.studentId, parentActor()),
      );

      const approved = await withTestTenant(async () =>
        childLinkService.approve(req.id, 'OK', adminActor()),
      );
      expect(approved.status).toBe('APPROVED');
      expect(approved.reviewerNotes).toBe('OK');

      const links = (await rawClient.$queryRawUnsafe(
        `SELECT id FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id = $1::uuid AND guardian_id = $2::uuid`,
        child.studentId,
        guardianId,
      )) as Array<{ id: string }>;
      expect(links).toHaveLength(1);

      // Kafka emit fired (best-effort)
      const calls = kafka.callsForTopic('iam.child.linked');
      expect(calls.length).toBe(1);
      expect((calls[0]!.payload as { studentId: string }).studentId).toBe(child.studentId);
    });

    it('admin approves ADD_NEW → new iam_person + platform_students + sis_students rows', async () => {
      const guardianId = await ensureParentGuardian();
      const req = await withTestTenant(async () =>
        childLinkService.submitAddNew(
          {
            firstName: 'FreshKid',
            lastName: 'FreshLast',
            dateOfBirth: '2020-01-01',
            gradeLevel: 'K',
          },
          parentActor(),
        ),
      );

      const approved = await withTestTenant(async () =>
        childLinkService.approve(req.id, undefined, adminActor()),
      );
      expect(approved.status).toBe('APPROVED');

      // A new sis_students row exists in this school with the new name
      const created = (await rawClient.$queryRawUnsafe(
        `SELECT s.id::text AS sid, ps.id::text AS psid, ip.id::text AS pid
           FROM ${TEST_SCHEMA}.sis_students s
           JOIN platform.platform_students ps ON ps.id = s.platform_student_id
           JOIN platform.iam_person ip ON ip.id = ps.person_id
          WHERE ip.first_name = 'FreshKid' AND ip.last_name = 'FreshLast'`,
      )) as Array<{ sid: string; psid: string; pid: string }>;
      expect(created).toHaveLength(1);
      // Track the auto-created rows for cleanup
      studentIds.push(created[0]!.sid);
      platformStudentIds.push(created[0]!.psid);
      personIds.push(created[0]!.pid);

      // Guardian link landed
      const links = (await rawClient.$queryRawUnsafe(
        `SELECT id FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id = $1::uuid AND guardian_id = $2::uuid`,
        created[0]!.sid,
        guardianId,
      )) as Array<{ id: string }>;
      expect(links).toHaveLength(1);
    });

    it('non-admin approve → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          childLinkService.approve(generateId(), undefined, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('approve a non-existent id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          childLinkService.approve(generateId(), undefined, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('approve a non-PENDING request → BadRequestException', async () => {
      const child = await trackedStudent();
      await ensureParentGuardian();
      const req = await withTestTenant(async () =>
        childLinkService.submitLinkExisting(child.studentId, parentActor()),
      );
      await withTestTenant(async () => childLinkService.approve(req.id, undefined, adminActor()));
      await expect(
        withTestTenant(async () =>
          childLinkService.approve(req.id, undefined, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('ChildLinkRequestService.reject', () => {
    it('admin rejects → status REJECTED + no link created', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      const req = await withTestTenant(async () =>
        childLinkService.submitLinkExisting(child.studentId, parentActor()),
      );
      const rejected = await withTestTenant(async () =>
        childLinkService.reject(req.id, 'Insufficient evidence', adminActor()),
      );
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.reviewerNotes).toBe('Insufficient evidence');

      const links = (await rawClient.$queryRawUnsafe(
        `SELECT id FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id = $1::uuid AND guardian_id = $2::uuid`,
        child.studentId,
        guardianId,
      )) as Array<{ id: string }>;
      expect(links).toHaveLength(0);
    });

    it('non-admin reject → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          childLinkService.reject(generateId(), undefined, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejecting a non-PENDING row → BadRequestException', async () => {
      const child = await trackedStudent();
      await ensureParentGuardian();
      const req = await withTestTenant(async () =>
        childLinkService.submitLinkExisting(child.studentId, parentActor()),
      );
      await withTestTenant(async () => childLinkService.reject(req.id, undefined, adminActor()));
      await expect(
        withTestTenant(async () =>
          childLinkService.reject(req.id, undefined, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ============================================================
  // ParentUpdateService
  // ============================================================
  describe('ParentUpdateService.submitRequest', () => {
    it('parent submits STUDENT_INFO change → PENDING + outbox row inside same tx', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);

      const req = await withTestTenant(async () =>
        parentUpdateService.submitRequest(
          {
            targetType: 'STUDENT_INFO',
            targetId: child.studentId,
            proposedChanges: { preferredName: 'Mango' },
          },
          parentActor(),
        ),
      );
      expect(req.status).toBe('PENDING');
      expect(req.targetType).toBe('STUDENT_INFO');

      const outboxRows = (await rawClient.$queryRawUnsafe(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'sis.parent_update.submitted' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ topic: string }>;
      expect(outboxRows).toHaveLength(1);
    });

    it('AUTO_APPROVED when every field has matching auto-approval rule', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);

      // Seed rule: STUDENT_INFO.preferredName auto_approve=true
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_auto_approval_rules
           (id, school_id, target_type, field_name, auto_approve)
         VALUES (gen_random_uuid(), $1::uuid, 'STUDENT_INFO', 'preferredName', true)`,
        TEST_SCHOOL_ID,
      );

      const req = await withTestTenant(async () =>
        parentUpdateService.submitRequest(
          {
            targetType: 'STUDENT_INFO',
            targetId: child.studentId,
            proposedChanges: { preferredName: 'Mango' },
          },
          parentActor(),
        ),
      );
      expect(req.status).toBe('AUTO_APPROVED');
      expect(req.appliedAt).not.toBeNull();
    });

    it('Mixed fields (some unmapped) → PENDING regardless of partial rule coverage', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_auto_approval_rules
           (id, school_id, target_type, field_name, auto_approve)
         VALUES (gen_random_uuid(), $1::uuid, 'STUDENT_INFO', 'preferredName', true)`,
        TEST_SCHOOL_ID,
      );
      const req = await withTestTenant(async () =>
        parentUpdateService.submitRequest(
          {
            targetType: 'STUDENT_INFO',
            targetId: child.studentId,
            proposedChanges: { preferredName: 'Mango', address: '1 Foo' },
          },
          parentActor(),
        ),
      );
      expect(req.status).toBe('PENDING');
    });

    it('parent not linked to student → ForbiddenException', async () => {
      const child = await trackedStudent();
      await ensureParentGuardian();
      // No linkStudentGuardian — parent has no relationship to this child.
      await expect(
        withTestTenant(async () =>
          parentUpdateService.submitRequest(
            {
              targetType: 'STUDENT_INFO',
              targetId: child.studentId,
              proposedChanges: { preferredName: 'Mango' },
            },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Invalid targetType → BadRequestException', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      await expect(
        withTestTenant(async () =>
          parentUpdateService.submitRequest(
            {
              targetType: 'BOGUS' as 'STUDENT_INFO',
              targetId: child.studentId,
              proposedChanges: { preferredName: 'X' },
            },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Empty proposedChanges → BadRequestException', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      await expect(
        withTestTenant(async () =>
          parentUpdateService.submitRequest(
            {
              targetType: 'STUDENT_INFO',
              targetId: child.studentId,
              proposedChanges: {},
            },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Non-GUARDIAN persona → ForbiddenException', async () => {
      const child = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          parentUpdateService.submitRequest(
            {
              targetType: 'STUDENT_INFO',
              targetId: child.studentId,
              proposedChanges: { x: 1 },
            },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('GUARDIAN_INFO target requires guardian link to a student in this school', async () => {
      const guardianId = await ensureParentGuardian();
      // No linked students at all
      await expect(
        withTestTenant(async () =>
          parentUpdateService.submitRequest(
            {
              targetType: 'GUARDIAN_INFO',
              targetId: guardianId,
              proposedChanges: { phone: '+1' },
            },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Now link
      const child = await trackedStudent();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      const req = await withTestTenant(async () =>
        parentUpdateService.submitRequest(
          {
            targetType: 'GUARDIAN_INFO',
            targetId: guardianId,
            proposedChanges: { phone: '+1' },
          },
          parentActor(),
        ),
      );
      expect(req.status).toBe('PENDING');
    });
  });

  describe('ParentUpdateService.reviewRequest', () => {
    it('admin approves → status APPROVED + applied_at set + outbox reviewed row', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      const req = await withTestTenant(async () =>
        parentUpdateService.submitRequest(
          {
            targetType: 'STUDENT_INFO',
            targetId: child.studentId,
            proposedChanges: { preferredName: 'Mango' },
          },
          parentActor(),
        ),
      );
      const reviewed = await withTestTenant(async () =>
        parentUpdateService.reviewRequest(
          req.id,
          { decision: 'APPROVED', reviewerNotes: 'OK' },
          adminActor(),
        ),
      );
      expect(reviewed.status).toBe('APPROVED');
      expect(reviewed.appliedAt).not.toBeNull();

      const outboxRows = (await rawClient.$queryRawUnsafe(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'sis.parent_update.reviewed' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ topic: string }>;
      expect(outboxRows).toHaveLength(1);
    });

    it('admin rejects → status REJECTED + applied_at NULL', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      const req = await withTestTenant(async () =>
        parentUpdateService.submitRequest(
          {
            targetType: 'STUDENT_INFO',
            targetId: child.studentId,
            proposedChanges: { preferredName: 'Mango' },
          },
          parentActor(),
        ),
      );
      const reviewed = await withTestTenant(async () =>
        parentUpdateService.reviewRequest(
          req.id,
          { decision: 'REJECTED' },
          adminActor(),
        ),
      );
      expect(reviewed.status).toBe('REJECTED');
      expect(reviewed.appliedAt).toBeNull();
    });

    it('Non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          parentUpdateService.reviewRequest(
            generateId(),
            { decision: 'APPROVED' },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Already-reviewed request → BadRequestException', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      const req = await withTestTenant(async () =>
        parentUpdateService.submitRequest(
          {
            targetType: 'STUDENT_INFO',
            targetId: child.studentId,
            proposedChanges: { preferredName: 'Mango' },
          },
          parentActor(),
        ),
      );
      await withTestTenant(async () =>
        parentUpdateService.reviewRequest(
          req.id,
          { decision: 'APPROVED' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          parentUpdateService.reviewRequest(
            req.id,
            { decision: 'REJECTED' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Invalid decision → BadRequestException', async () => {
      // Note: admin scope check happens first, but the synthetic adminActor()
      // is isSchoolAdmin=true so it passes; then decision validation fires.
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      const req = await withTestTenant(async () =>
        parentUpdateService.submitRequest(
          {
            targetType: 'STUDENT_INFO',
            targetId: child.studentId,
            proposedChanges: { preferredName: 'Mango' },
          },
          parentActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          parentUpdateService.reviewRequest(
            req.id,
            { decision: 'WAT' as 'APPROVED' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('ParentUpdateService.listRequests + getByIdOrFail', () => {
    it('parent only sees own requests; admin sees all', async () => {
      const child = await trackedStudent();
      const guardianId = await ensureParentGuardian();
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      const req = await withTestTenant(async () =>
        parentUpdateService.submitRequest(
          {
            targetType: 'STUDENT_INFO',
            targetId: child.studentId,
            proposedChanges: { preferredName: 'M' },
          },
          parentActor(),
        ),
      );
      // Another parent's request, submitted directly into the table
      const otherG = await trackedGuardian();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_parent_info_update_requests
           (id, school_id, submitted_by, target_type, target_id, proposed_changes, status)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'STUDENT_INFO', $3::uuid, $4::jsonb, 'PENDING')`,
        TEST_SCHOOL_ID,
        otherG.personId,
        child.studentId,
        JSON.stringify({ foo: 'bar' }),
      );

      const parentList = await withTestTenant(async () =>
        parentUpdateService.listRequests(parentActor(), {}),
      );
      expect(parentList).toHaveLength(1);
      expect(parentList[0]!.id).toBe(req.id);

      const adminList = await withTestTenant(async () =>
        parentUpdateService.listRequests(adminActor(), {}),
      );
      expect(adminList.length).toBeGreaterThanOrEqual(2);

      const adminPending = await withTestTenant(async () =>
        parentUpdateService.listRequests(adminActor(), { status: 'PENDING' }),
      );
      expect(adminPending.length).toBeGreaterThanOrEqual(2);
    });

    it('getByIdOrFail: cross-parent peek → 404', async () => {
      const child = await trackedStudent();
      const otherG = await trackedGuardian();
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_parent_info_update_requests
           (id, school_id, submitted_by, target_type, target_id, proposed_changes, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'STUDENT_INFO', $4::uuid, $5::jsonb, 'PENDING')`,
        id,
        TEST_SCHOOL_ID,
        otherG.personId,
        child.studentId,
        JSON.stringify({ x: 1 }),
      );
      await ensureParentGuardian();
      await expect(
        withTestTenant(async () =>
          parentUpdateService.getByIdOrFail(id, parentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin getByIdOrFail returns the row', async () => {
      const child = await trackedStudent();
      const otherG = await trackedGuardian();
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_parent_info_update_requests
           (id, school_id, submitted_by, target_type, target_id, proposed_changes, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'STUDENT_INFO', $4::uuid, $5::jsonb, 'PENDING')`,
        id,
        TEST_SCHOOL_ID,
        otherG.personId,
        child.studentId,
        JSON.stringify({ x: 1 }),
      );
      const row = await withTestTenant(async () =>
        parentUpdateService.getByIdOrFail(id, adminActor()),
      );
      expect(row.id).toBe(id);
    });
  });

  describe('ParentUpdateService.listRules + upsertRule', () => {
    it('admin upserts and reads a rule', async () => {
      const rule = await withTestTenant(async () =>
        parentUpdateService.upsertRule(
          { targetType: 'STUDENT_INFO', fieldName: 'preferredName', autoApprove: true },
          adminActor(),
        ),
      );
      expect(rule.autoApprove).toBe(true);

      // Upsert with autoApprove=false → same id semantics, value flipped
      const flipped = await withTestTenant(async () =>
        parentUpdateService.upsertRule(
          { targetType: 'STUDENT_INFO', fieldName: 'preferredName', autoApprove: false },
          adminActor(),
        ),
      );
      expect(flipped.autoApprove).toBe(false);

      const list = await withTestTenant(async () => parentUpdateService.listRules());
      expect(list).toHaveLength(1);
    });

    it('non-admin upsertRule → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          parentUpdateService.upsertRule(
            { targetType: 'STUDENT_INFO', fieldName: 'preferredName', autoApprove: true },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Invalid targetType in upsertRule → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          parentUpdateService.upsertRule(
            { targetType: 'BOGUS' as 'STUDENT_INFO', fieldName: 'x', autoApprove: true },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ============================================================
  // Cross-school isolation
  // ============================================================
  describe('cross-school isolation', () => {
    it('Parent in school A cannot submit update for a child in school B (verifyGuardianTargetLink)', async () => {
      // Seed a child in School B; the parent only has a guardian row in school A.
      const childB = await trackedStudent({
        schoolId: TEST_SCHOOL_B_ID,
        firstName: 'B',
        lastName: 'Child',
      });
      await ensureParentGuardian(); // guardian row in school A only

      // Parent submits while pinned to school A — should reject because
      // the verifyGuardianTargetLink predicate binds s.school_id=tenant.schoolId
      // and the child lives in school B.
      await expect(
        withTestTenant(async () =>
          parentUpdateService.submitRequest(
            {
              targetType: 'STUDENT_INFO',
              targetId: childB.studentId,
              proposedChanges: { preferredName: 'X' },
            },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin in school A cannot review a school B parent-update request via getByIdOrFail', async () => {
      const childB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      const otherG = await trackedGuardian({ schoolId: TEST_SCHOOL_B_ID });
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_parent_info_update_requests
           (id, school_id, submitted_by, target_type, target_id, proposed_changes, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'STUDENT_INFO', $4::uuid, $5::jsonb, 'PENDING')`,
        reqId,
        TEST_SCHOOL_B_ID,
        otherG.personId,
        childB.studentId,
        JSON.stringify({ x: 1 }),
      );

      // School A admin queries → 404 because school_id predicate filters it out
      await expect(
        withTestTenant(async () =>
          parentUpdateService.getByIdOrFail(reqId, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Confirm school B admin can see it
      const row = await withTestTenantB(async () =>
        parentUpdateService.getByIdOrFail(reqId, adminActor()),
      );
      expect(row.id).toBe(reqId);
    });
  });
});
