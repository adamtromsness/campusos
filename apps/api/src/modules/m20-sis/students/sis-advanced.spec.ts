import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { StudentProfileService } from './student-profile.service';
import { CustomFieldService } from '../custom-fields/custom-field.service';
import { ParentUpdateService } from '../guardians/parent-update.service';
import { StudentNoteService } from '../notes/student-note.service';
import { FamilyRelationshipService } from '../family/family-relationship.service';
import { SisAdvancedController } from './sis-advanced.controller';

/**
 * P2-13a vertical slice spec.
 *
 * Coverage:
 *   S1. Student profile getOrCreate auto-inserts an empty profile.
 *   S2. updateProfile rejects non-owner non-admin actors.
 *   S3. uploadAvatar lands as PENDING_APPROVAL.
 *   S4. reviewAvatar is teacher / admin only and emits sis.avatar.reviewed.
 *   S5. CustomFieldService.createDefinition rejects ENUM without options.
 *   S6. CustomFieldService.upsertValues rejects mismatched value type.
 *   S7. CustomFieldService.upsertValues rejects ENUM values not in enum_options.
 *   S8. ParentUpdateService.submit auto-approves when every field is allow-listed.
 *   S9. ParentUpdateService.submit lands PENDING when any field lacks rule.
 *   S10. ParentUpdateService.review is admin-only and stamps reviewer + applied_at.
 *   S11. StudentNoteService.create rejects CONFIDENTIAL + is_visible_to_parent.
 *   S12. StudentNoteService.list excludes CONFIDENTIAL for non-authors.
 *   S13. FamilyRelationshipService.create rejects self-link.
 *   S14. Controller permission metadata pinned to STU-001/STU-002.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0aaa-aaaa-7556-8c81-f07b3369e584',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e0aaa-aaaa-7556-8c81-000000000001',
  personId: '019e0aaa-aaaa-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e0aaa-aaaa-7556-8c81-000000000099',
} as never;

const TEACHER_ACTOR = {
  accountId: '019e0aaa-aaaa-7556-8c81-100000000001',
  personId: '019e0aaa-aaaa-7556-8c81-100000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: '019e0aaa-aaaa-7556-8c81-100000000099',
} as never;

const STUDENT_ACTOR = {
  accountId: '019e0aaa-aaaa-7556-8c81-200000000001',
  personId: '019e0aaa-aaaa-7556-8c81-200000000002',
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
  employeeId: null,
} as never;

const PARENT_ACTOR = {
  accountId: '019e0aaa-aaaa-7556-8c81-300000000001',
  personId: '019e0aaa-aaaa-7556-8c81-300000000002',
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
  employeeId: null,
} as never;

const STUDENT_ID = '019e0aaa-aaaa-7556-8c81-400000000001';
const PROFILE_ID = '019e0aaa-aaaa-7556-8c81-500000000001';

interface CapturedCall {
  sql: string;
  args: unknown[];
}

interface FakeOptions {
  responder?: (call: CapturedCall) => unknown;
}

function makeFake(responder?: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async <T = unknown>(sql: string, ...args: unknown[]): Promise<T> => {
      capture.push({ sql, args });
      const r = responder?.({ sql, args });
      return (r ?? []) as T;
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]): Promise<number> => {
      capture.push({ sql, args });
      const r = responder?.({ sql, args });
      if (typeof r === 'number') return r;
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T = unknown>(fn: (c: unknown) => Promise<T>): Promise<T> =>
      fn(client),
    executeInTenantTransaction: async <T = unknown>(fn: (c: unknown) => Promise<T>): Promise<T> =>
      fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeKafka() {
  const emits: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
  }> = [];
  return {
    emits,
    kafka: {
      emit: async (opts: {
        topic: string;
        key: string;
        sourceModule: string;
        payload: Record<string, unknown>;
      }) => {
        emits.push({
          topic: opts.topic,
          sourceModule: opts.sourceModule,
          key: opts.key,
          payload: opts.payload,
        });
      },
    },
  };
}

function makePerms(grant = true) {
  return {
    hasAnyPermissionInTenant: async () => grant,
  };
}

/**
 * REVIEW-P2C13 outbox stub — captures every enqueueInTx so tests can
 * assert durable emits land with the deterministic event_id helper.
 */
function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
      return 'outbox-id';
    },
  };
  return { outbox, enqueued };
}

// ─── S1: getOrCreate auto-inserts when missing ───

describe('SIS Advanced — P2-13a', () => {
  it('S1: getOrCreateProfile creates an empty profile on first read', async () => {
    let firstSelect = true;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes('select id::text, student_id::text, bio,') ||
        sql.includes('select p.id::text, p.student_id::text, p.bio,')
      ) {
        if (firstSelect) {
          firstSelect = false;
          return [];
        }
        return [
          {
            id: PROFILE_ID,
            student_id: STUDENT_ID,
            bio: null,
            currently_reading: null,
            favourite_song: null,
            interests: [],
            motto: null,
            avatar_s3_key: null,
            avatar_status: 'PENDING_APPROVAL',
            avatar_reviewed_by: null,
            avatar_reviewed_at: null,
            avatar_review_notes: null,
            created_at: 't',
            updated_at: 't',
          },
        ];
      }
      if (sql.startsWith('select 1 as ok from sis_students')) {
        return [{ ok: 1 }];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new StudentProfileService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.getOrCreateProfile(STUDENT_ID, ADMIN_ACTOR),
    );
    expect(dto.studentId).toBe(STUDENT_ID);
    expect(dto.avatarStatus).toBe('PENDING_APPROVAL');
    const insert = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into sis_student_profiles'),
    );
    expect(insert).toBeDefined();
  });

  // ─── S2: updateProfile rejects non-owner non-admin ───
  it('S2: updateProfile refuses non-owner non-admin actor', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.startsWith('select 1 as ok from sis_students')) return [{ ok: 1 }];
      // resolveOwnStudentId returns a different id than studentId so the
      // student actor does not own the target.
      if (sql.includes('from sis_students s') && sql.includes('platform_students')) {
        return [{ id: 'some-other-student-id' }];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new StudentProfileService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.updateProfile(STUDENT_ID, { bio: 'mine' }, STUDENT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── S3: uploadAvatar lands PENDING_APPROVAL ───
  it('S3: uploadAvatar resets status to PENDING_APPROVAL and clears reviewer audit', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.startsWith('select 1 as ok from sis_students')) return [{ ok: 1 }];
      if (sql.includes('from sis_students s') && sql.includes('platform_students')) {
        return [{ id: STUDENT_ID }];
      }
      if (sql.includes('select id::text as id from sis_student_profiles')) {
        return [{ id: PROFILE_ID }];
      }
      if (
        sql.startsWith('select id::text, student_id::text, bio,') ||
        sql.startsWith('select p.id::text, p.student_id::text, p.bio,')
      ) {
        return [
          {
            id: PROFILE_ID,
            student_id: STUDENT_ID,
            bio: null,
            currently_reading: null,
            favourite_song: null,
            interests: [],
            motto: null,
            avatar_s3_key: 'avatars/new.jpg',
            avatar_status: 'PENDING_APPROVAL',
            avatar_reviewed_by: null,
            avatar_reviewed_at: null,
            avatar_review_notes: null,
            created_at: 't',
            updated_at: 't',
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new StudentProfileService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.uploadAvatar(STUDENT_ID, { s3Key: 'avatars/new.jpg' }, STUDENT_ACTOR),
    );
    expect(dto.avatarStatus).toBe('PENDING_APPROVAL');
    const update = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes("avatar_status = 'pending_approval'") ||
        c.sql.toLowerCase().includes('avatar_s3_key, avatar_status'),
    );
    expect(update).toBeDefined();
  });

  // ─── S4: reviewAvatar emits sis.avatar.reviewed ───
  it('S4: reviewAvatar by teacher emits sis.avatar.reviewed', async () => {
    let reviewedYet = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes('select id::text as id, avatar_status as status') ||
        sql.includes('select p.id::text as id, p.avatar_status as status')
      ) {
        return [{ id: PROFILE_ID, status: 'PENDING_APPROVAL' }];
      }
      if (
        sql.startsWith('select id::text, student_id::text, bio,') ||
        sql.startsWith('select p.id::text, p.student_id::text, p.bio,')
      ) {
        return [
          {
            id: PROFILE_ID,
            student_id: STUDENT_ID,
            bio: null,
            currently_reading: null,
            favourite_song: null,
            interests: [],
            motto: null,
            avatar_s3_key: 'avatars/new.jpg',
            avatar_status: reviewedYet ? 'APPROVED' : 'PENDING_APPROVAL',
            avatar_reviewed_by: reviewedYet ? TEACHER_ACTOR.personId : null,
            avatar_reviewed_at: reviewedYet ? '2026-05-11T00:00:00Z' : null,
            avatar_review_notes: null,
            created_at: 't',
            updated_at: 't',
          },
        ];
      }
      if (sql.startsWith('update sis_student_profiles')) {
        reviewedYet = true;
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new StudentProfileService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.reviewAvatar(PROFILE_ID, { decision: 'APPROVED' }, TEACHER_ACTOR),
    );
    expect(dto.avatarStatus).toBe('APPROVED');
    // REVIEW-P2C13 — durable outbox emit lands inside the same tx as the
    // status flip; assert via the OutboxService stub.
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.topic).toBe('sis.avatar.reviewed');
    expect(enqueued[0]!.sourceModule).toBe('sis-advanced');
    expect(enqueued[0]!.eventId).toBeTruthy();
    expect((enqueued[0]!.payload as { decision: string }).decision).toBe('APPROVED');
  });

  // ─── S5: createDefinition rejects ENUM without enumOptions ───
  it('S5: CustomFieldService rejects ENUM without enum_options', async () => {
    const fake = makeFake();
    const svc = new CustomFieldService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'shirt',
            fieldLabel: 'Shirt',
            fieldType: 'ENUM',
            enumOptions: [],
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S6 + S7: upsertValues type + enum_options validation ───
  it('S6: CustomFieldService.upsertValues rejects TEXT-typed value supplied as number', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_custom_field_definitions')) {
        return [
          {
            id: 'def-1',
            school_id: SCHOOL.schoolId,
            entity_type: 'STUDENT',
            field_name: 'bus_route',
            field_label: 'Bus Route',
            field_type: 'TEXT',
            enum_options: null,
            is_required: false,
            is_visible_to_parent: true,
            sort_order: 0,
            is_active: true,
          },
        ];
      }
      return [];
    });
    const svc = new CustomFieldService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.upsertValues(
          {
            entityType: 'STUDENT',
            entityId: STUDENT_ID,
            values: [{ definitionId: 'def-1', value: 42 }],
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('S7: CustomFieldService.upsertValues rejects ENUM value not in options', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_custom_field_definitions')) {
        return [
          {
            id: 'def-2',
            school_id: SCHOOL.schoolId,
            entity_type: 'STUDENT',
            field_name: 'shirt',
            field_label: 'Shirt',
            field_type: 'ENUM',
            enum_options: ['S', 'M', 'L'],
            is_required: false,
            is_visible_to_parent: true,
            sort_order: 0,
            is_active: true,
          },
        ];
      }
      return [];
    });
    const svc = new CustomFieldService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.upsertValues(
          {
            entityType: 'STUDENT',
            entityId: STUDENT_ID,
            values: [{ definitionId: 'def-2', value: 'XXL' }],
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S8: ParentUpdateService AUTO_APPROVED when every field allow-listed ───
  it('S8: ParentUpdateService auto-approves when every field has auto_approve=true', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_guardians')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from sis_auto_approval_rules')) {
        return [{ field_name: 'personal_email', auto_approve: true }];
      }
      if (sql.startsWith('select id::text, school_id::text, submitted_by::text')) {
        return [
          {
            id: 'req-1',
            school_id: SCHOOL.schoolId,
            submitted_by: PARENT_ACTOR.personId,
            target_type: 'GUARDIAN_INFO',
            target_id: 'guardian-1',
            proposed_changes: { personal_email: 'new@example.com' },
            change_reason: null,
            status: 'AUTO_APPROVED',
            reviewed_by: null,
            reviewed_at: null,
            reviewer_notes: null,
            applied_at: '2026-05-11T00:00:00Z',
            created_at: 't',
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new ParentUpdateService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.submitRequest(
        {
          targetType: 'GUARDIAN_INFO',
          targetId: 'guardian-1',
          proposedChanges: { personal_email: 'new@example.com' },
        } as never,
        PARENT_ACTOR,
      ),
    );
    expect(dto.status).toBe('AUTO_APPROVED');
    expect(dto.appliedAt).not.toBeNull();
    // REVIEW-P2C13 — durable outbox emit lands inside the same tenant tx
    // as the INSERT so the downstream notification cannot be dropped.
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.topic).toBe('sis.parent_update.submitted');
    expect(enqueued[0]!.eventId).toBeTruthy();
    expect((enqueued[0]!.payload as { autoApproved: boolean }).autoApproved).toBe(true);
  });

  it('S9: ParentUpdateService lands PENDING when any field lacks an auto_approve rule', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_guardians')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from sis_auto_approval_rules')) {
        // Returns only the email rule; mailing_address has no rule.
        return [{ field_name: 'personal_email', auto_approve: true }];
      }
      if (sql.startsWith('select id::text, school_id::text, submitted_by::text')) {
        return [
          {
            id: 'req-2',
            school_id: SCHOOL.schoolId,
            submitted_by: PARENT_ACTOR.personId,
            target_type: 'GUARDIAN_INFO',
            target_id: 'guardian-1',
            proposed_changes: { mailing_address: '123 Elm St' },
            change_reason: null,
            status: 'PENDING',
            reviewed_by: null,
            reviewed_at: null,
            reviewer_notes: null,
            applied_at: null,
            created_at: 't',
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new ParentUpdateService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.submitRequest(
        {
          targetType: 'GUARDIAN_INFO',
          targetId: 'guardian-1',
          proposedChanges: { mailing_address: '123 Elm St' },
        } as never,
        PARENT_ACTOR,
      ),
    );
    expect(dto.status).toBe('PENDING');
    expect(dto.appliedAt).toBeNull();
  });

  // ─── S10: review is admin-only and stamps reviewer ───
  it('S10: reviewRequest stamps reviewer + applied_at on APPROVE', async () => {
    let reviewed = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id, status from sis_parent_info_update_requests')) {
        return [{ id: 'req-3', status: 'PENDING' }];
      }
      if (sql.startsWith('update sis_parent_info_update_requests')) {
        reviewed = true;
        return [];
      }
      if (sql.startsWith('select id::text, school_id::text, submitted_by::text')) {
        return [
          {
            id: 'req-3',
            school_id: SCHOOL.schoolId,
            submitted_by: PARENT_ACTOR.personId,
            target_type: 'GUARDIAN_INFO',
            target_id: 'guardian-1',
            proposed_changes: { mailing_address: '123 Elm St' },
            change_reason: null,
            status: reviewed ? 'APPROVED' : 'PENDING',
            reviewed_by: reviewed ? ADMIN_ACTOR.personId : null,
            reviewed_at: reviewed ? '2026-05-11T00:00:00Z' : null,
            reviewer_notes: null,
            applied_at: reviewed ? '2026-05-11T00:00:00Z' : null,
            created_at: 't',
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new ParentUpdateService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.reviewRequest('req-3', { decision: 'APPROVED' } as never, ADMIN_ACTOR),
    );
    expect(dto.status).toBe('APPROVED');
    expect(dto.appliedAt).not.toBeNull();
    // REVIEW-P2C13 — durable outbox emit lands inside the same tenant tx
    // as the lock + UPDATE.
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.topic).toBe('sis.parent_update.reviewed');
    expect(enqueued[0]!.eventId).toBeTruthy();
  });

  // ─── S11: CONFIDENTIAL + visible_to_parent rejected ───
  it('S11: createStudentNote rejects CONFIDENTIAL + is_visible_to_parent combination', async () => {
    const fake = makeFake();
    const svc = new StudentNoteService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.createForStudent(
          STUDENT_ID,
          {
            noteType: 'CONFIDENTIAL',
            noteText: 'sensitive',
            isVisibleToParent: true,
            isConfidential: true,
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S12: list excludes CONFIDENTIAL for non-authors ───
  it('S12: listForStudent applies STAFF visibility filter excluding confidentials from other authors', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.startsWith('select 1 as ok from sis_students')) return [{ ok: 1 }];
      return [];
    });
    const svc = new StudentNoteService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.listForStudent(STUDENT_ID, TEACHER_ACTOR),
    );
    const listSql = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('from sis_student_notes n'),
    );
    expect(listSql).toBeDefined();
    expect(listSql!.sql.toLowerCase()).toContain('is_confidential = false');
    expect(listSql!.sql.toLowerCase()).toContain('author_id = $');
    // TEACHER_ACTOR.personId is bound after studentId
    expect(listSql!.args).toContain(TEACHER_ACTOR.personId);
  });

  it('S12b: listForStudent applies GUARDIAN visibility filter narrowing to parent-visible non-confidential', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.startsWith('select 1 as ok from sis_students')) return [{ ok: 1 }];
      return [];
    });
    const svc = new StudentNoteService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.listForStudent(STUDENT_ID, PARENT_ACTOR),
    );
    const listSql = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('from sis_student_notes n'),
    );
    expect(listSql).toBeDefined();
    expect(listSql!.sql.toLowerCase()).toContain('is_parent_visible = true');
    expect(listSql!.sql.toLowerCase()).toContain('is_confidential = false');
    expect(listSql!.sql.toLowerCase()).toContain('sis_student_guardians');
  });

  // ─── S13: FamilyRelationship rejects self-link ───
  it('S13: FamilyRelationshipService.create rejects self-link', async () => {
    const fake = makeFake();
    const svc = new FamilyRelationshipService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.create(
          {
            familyId: 'fam-1',
            guardianAId: 'guardian-1',
            guardianBId: 'guardian-1',
            relationshipType: 'MARRIED',
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S14: Controller permission metadata ───
  it('S14: controller permission metadata is pinned to STU-001 / STU-002 codes', () => {
    type Handler = (...args: never[]) => unknown;
    const handlers: Array<{ name: keyof SisAdvancedController; expected: string[] }> = [
      { name: 'getProfile', expected: ['stu-001:read'] },
      { name: 'updateProfile', expected: ['stu-002:write'] },
      { name: 'uploadAvatar', expected: ['stu-002:write'] },
      { name: 'reviewAvatar', expected: ['stu-002:write'] },
      { name: 'createCustomField', expected: ['stu-002:admin'] },
      { name: 'submitParentUpdate', expected: ['stu-002:write'] },
      { name: 'reviewParentUpdate', expected: ['stu-002:admin'] },
      { name: 'createStudentNote', expected: ['stu-002:write'] },
      { name: 'createFamilyRelationship', expected: ['stu-002:admin'] },
    ];
    for (const { name, expected } of handlers) {
      const fn = SisAdvancedController.prototype[name] as unknown as Handler;
      const codes = Reflect.getMetadata(PERMISSIONS_KEY, fn) as string[];
      expect(codes).toEqual(expected);
    }
  });

  // ─── Integration: STU-002 and STU-001 NotFoundException for missing student ───
  it('integration: getOrCreateProfile throws NotFound on missing student', async () => {
    const fake = makeFake();
    const { outbox } = makeOutbox();
    const svc = new StudentProfileService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(svc.getOrCreateProfile(STUDENT_ID, ADMIN_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ─── REVIEW-P2C13 REGRESSION TESTS ───

  /**
   * R-B1: profile reads carry school_id on every direct object lookup.
   * The assertStudentExists query is the foundational gate; it must
   * include `school_id = $2::uuid`.
   */
  it('R-B1: assertStudentExists binds tenant.schoolId', async () => {
    const fake = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new StudentProfileService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(svc.getOrCreateProfile(STUDENT_ID, ADMIN_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    const lookup = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('select 1 as ok from sis_students') &&
        c.sql.toLowerCase().includes('school_id = $2::uuid'),
    );
    expect(lookup).toBeDefined();
  });

  /**
   * R-B1b: STAFF (non-admin) actors no longer blanket-bypass profile
   * row-scope. A teacher without stu-002:write and without an
   * assigned-class link to the student is refused.
   */
  it('R-B1b: STAFF without stu-002:write or assigned-class link is refused', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.startsWith('select 1 as ok from sis_students')) return [{ ok: 1 }];
      // No class teacher link.
      if (sql.includes('from sis_class_teachers')) return [];
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new StudentProfileService(
      fake.tenantPrisma as never,
      makePerms(false) as never, // no stu-002:write
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(svc.getOrCreateProfile(STUDENT_ID, TEACHER_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  /**
   * R-B2: pending-avatar queue binds school predicate so a reviewer
   * in school A cannot see pending avatars from school B.
   */
  it('R-B2: pending-avatar queue binds sis_students.school_id', async () => {
    const fake = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new StudentProfileService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await svc.listPendingAvatars(ADMIN_ACTOR);
    });
    const sql = fake.capture[0]!.sql.toLowerCase();
    expect(sql).toContain('join sis_students s');
    expect(sql).toContain("avatar_status = 'pending_approval'");
    expect(sql).toContain('s.school_id = $1::uuid');
  });

  /**
   * R-B3: parent-update review lock + UPDATE carry the school predicate.
   */
  it('R-B3: parent-update review lock binds school_id', async () => {
    const fake = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new ParentUpdateService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.reviewRequest(
          '019e1500-0000-7556-8c81-aaaaaaaaaaaa',
          { decision: 'APPROVED' } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    const lockSql = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('from sis_parent_info_update_requests') &&
        c.sql.toLowerCase().includes('school_id = $2::uuid') &&
        c.sql.toLowerCase().includes('for update'),
    );
    expect(lockSql).toBeDefined();
  });
});
