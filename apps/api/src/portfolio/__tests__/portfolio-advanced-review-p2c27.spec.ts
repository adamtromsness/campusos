import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '../../tenant/tenant.context';
import { PortfolioSectionService } from '../section.service';
import { EndorsementService } from '../endorsement.service';
import { ReadinessPathwayService } from '../readiness.service';
import { CollegeApplicationService } from '../college-application.service';
import { ResumeService } from '../resume.service';
import { deterministicMilestoneCompletedEventId } from '../event-ids';
import {
  isLinkedGuardianOf,
  isStudentInCurrentSchool,
  isAssignedTeacherOf,
  resolveStudentIdForActor,
} from '../portfolio-access';

/**
 * REVIEW-P2C27 ROUND 1 — regression tests pinning the six BLOCKING fixes
 * so future maintenance cannot regress them.
 *
 *   R-B1  Durable outbox for pfl.pathway.milestone_completed
 *   R-B2  Shared portfolio access helpers carry school predicate
 *   R-B3  Readiness assignment / milestone paths school-scoped
 *   R-B4  College application paths school-scoped
 *   R-B5  Section + endorsement update / delete / reload paths school-scoped
 *   R-B6  Resume cross-module aggregation school-scoped
 */

const SCHOOL = {
  schoolId: 'school-aaaa',
  schemaName: 'tenant_demo',
  organisationId: null,
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'SMALL',
  homeRegion: 'us-east-1',
} as const;

const ADMIN_ACTOR = {
  accountId: 'admin-account',
  personId: 'admin-person',
  employeeId: 'admin-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
};

const COUNSELLOR_ACTOR = {
  accountId: 'cou-account',
  personId: 'cou-person',
  employeeId: 'cou-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};

const TEACHER_ACTOR = {
  accountId: 'teacher-account',
  personId: 'teacher-person',
  employeeId: 'teacher-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};

const STUDENT_ACTOR = {
  accountId: 'student-account',
  personId: 'maya-person',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
};

const PARENT_ACTOR = {
  accountId: 'parent-account',
  personId: 'david-person',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
};

const MAYA_STUDENT_ID = 'maya-student-id';
const PORTFOLIO_ID = 'portfolio-id';
const SECTION_ID = 'section-id';
const ENDORSEMENT_ID = 'endorsement-id';
const PATHWAY_ID = 'pathway-id';
const ASSIGNMENT_ID = 'assignment-id';
const MILESTONE_ID = 'milestone-id';
const APP_ID = 'college-app-id';

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

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
    },
  };
  return { outbox, enqueued };
}

function makePermCheck(resolver: (accountId: string, codes: string[]) => boolean = () => false) {
  return {
    hasAnyPermissionInTenant: async (accountId: string, _schoolId: string, codes: string[]) =>
      resolver(accountId, codes),
  } as never;
}

function withTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, async () => fn()) as Promise<T>;
}

// ─────────────────────────────────────────────────────────────
// R-B1 — Durable outbox for pfl.pathway.milestone_completed
// ─────────────────────────────────────────────────────────────

describe('R-B1 — REVIEW-P2C27 BLOCKING 1: durable outbox for milestone_completed', () => {
  it('deterministicMilestoneCompletedEventId is stable across invocations', () => {
    const a = deterministicMilestoneCompletedEventId(ASSIGNMENT_ID, MILESTONE_ID);
    const b = deterministicMilestoneCompletedEventId(ASSIGNMENT_ID, MILESTONE_ID);
    expect(a).toBe(b);
  });

  it('deterministicMilestoneCompletedEventId returns a v5-shape UUID', () => {
    const id = deterministicMilestoneCompletedEventId(ASSIGNMENT_ID, MILESTONE_ID);
    // 8-4-4-4-12 hex, v5 marker '5' at position 14, variant marker 8/9/a/b at 19
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('deterministicMilestoneCompletedEventId differs across milestoneIds', () => {
    const a = deterministicMilestoneCompletedEventId(ASSIGNMENT_ID, 'milestone-A');
    const b = deterministicMilestoneCompletedEventId(ASSIGNMENT_ID, 'milestone-B');
    expect(a).not.toBe(b);
  });

  it('emits pfl.pathway.milestone_completed via OutboxService.enqueueInTx on STATUS=COMPLETED transition', async () => {
    const fake = makeFake((call) => {
      // assignment lock + state
      if (
        call.sql.includes('FROM pfl_student_pathway_assignments a') &&
        call.sql.includes('FOR UPDATE OF a')
      ) {
        return [
          {
            id: ASSIGNMENT_ID,
            student_id: MAYA_STUDENT_ID,
            pathway_id: PATHWAY_ID,
            milestone_statuses: [],
            overall_progress: 0,
            status: 'ACTIVE',
          },
        ];
      }
      // milestone validation
      if (
        call.sql.includes('FROM pfl_pathway_milestones m') &&
        call.sql.includes('m.id = $1::uuid') &&
        call.sql.includes('m.pathway_id = $2::uuid')
      ) {
        return [{ id: MILESTONE_ID, is_required: true, milestone_name: 'Submit transcript' }];
      }
      // resolveStudentIdForActor — STUDENT path
      if (
        call.sql.includes('FROM sis_students s') &&
        call.sql.includes('JOIN platform.platform_students ps')
      ) {
        return [{ id: MAYA_STUDENT_ID }];
      }
      // required-milestones list for progress computation
      if (
        call.sql.includes('FROM pfl_pathway_milestones m') &&
        call.sql.includes('m.pathway_id = $1::uuid')
      ) {
        return [{ id: MILESTONE_ID, is_required: true }];
      }
      // post-update reload
      if (call.sql.includes('FROM pfl_student_pathway_assignments a')) {
        return [
          {
            id: ASSIGNMENT_ID,
            student_id: MAYA_STUDENT_ID,
            student_name: 'Maya Chen',
            pathway_id: PATHWAY_ID,
            pathway_name: 'Pre-University',
            pathway_type: 'UNIVERSITY_PREP',
            assigned_by: 'emp',
            assigned_by_name: 'Coun',
            assigned_at: '2026-01-01T00:00:00Z',
            milestone_statuses: [],
            overall_progress: 100,
            status: 'ACTIVE',
            notes: null,
            updated_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new ReadinessPathwayService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    await withTenant(() =>
      svc.updateMilestoneStatus(ASSIGNMENT_ID, STUDENT_ACTOR, {
        milestoneId: MILESTONE_ID,
        status: 'COMPLETED',
      }),
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('pfl.pathway.milestone_completed');
    expect(enqueued[0]!.sourceModule).toBe('portfolio');
    expect(enqueued[0]!.eventId).toBe(
      deterministicMilestoneCompletedEventId(ASSIGNMENT_ID, MILESTONE_ID),
    );
    expect(enqueued[0]!.payload).toMatchObject({
      assignmentId: ASSIGNMENT_ID,
      pathwayId: PATHWAY_ID,
      studentId: MAYA_STUDENT_ID,
      schoolId: SCHOOL.schoolId,
      milestoneId: MILESTONE_ID,
    });
  });

  it('does NOT emit when milestone was already COMPLETED (no transition)', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM pfl_student_pathway_assignments a') &&
        call.sql.includes('FOR UPDATE OF a')
      ) {
        return [
          {
            id: ASSIGNMENT_ID,
            student_id: MAYA_STUDENT_ID,
            pathway_id: PATHWAY_ID,
            milestone_statuses: [
              { milestone_id: MILESTONE_ID, status: 'COMPLETED', completed_at: '2026-01-01' },
            ],
            overall_progress: 100,
            status: 'ACTIVE',
          },
        ];
      }
      if (
        call.sql.includes('FROM pfl_pathway_milestones m') &&
        call.sql.includes('m.id = $1::uuid') &&
        call.sql.includes('m.pathway_id = $2::uuid')
      ) {
        return [{ id: MILESTONE_ID, is_required: true, milestone_name: 'Submit transcript' }];
      }
      if (
        call.sql.includes('FROM sis_students s') &&
        call.sql.includes('JOIN platform.platform_students ps')
      ) {
        return [{ id: MAYA_STUDENT_ID }];
      }
      if (
        call.sql.includes('FROM pfl_pathway_milestones m') &&
        call.sql.includes('m.pathway_id = $1::uuid')
      ) {
        return [{ id: MILESTONE_ID, is_required: true }];
      }
      if (call.sql.includes('FROM pfl_student_pathway_assignments a')) {
        return [
          {
            id: ASSIGNMENT_ID,
            student_id: MAYA_STUDENT_ID,
            student_name: 'Maya Chen',
            pathway_id: PATHWAY_ID,
            pathway_name: 'Pre-University',
            pathway_type: 'UNIVERSITY_PREP',
            assigned_by: 'emp',
            assigned_by_name: 'Coun',
            assigned_at: '2026-01-01T00:00:00Z',
            milestone_statuses: [
              { milestone_id: MILESTONE_ID, status: 'COMPLETED', completed_at: '2026-01-01' },
            ],
            overall_progress: 100,
            status: 'ACTIVE',
            notes: null,
            updated_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new ReadinessPathwayService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    await withTenant(() =>
      svc.updateMilestoneStatus(ASSIGNMENT_ID, STUDENT_ACTOR, {
        milestoneId: MILESTONE_ID,
        status: 'COMPLETED',
      }),
    );
    expect(enqueued).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// R-B2 — Shared helpers carry school predicate
// ─────────────────────────────────────────────────────────────

describe('R-B2 — REVIEW-P2C27 BLOCKING 2: shared portfolio access helpers school-scoped', () => {
  it('resolveStudentIdForActor query carries s.school_id predicate', async () => {
    const fake = makeFake(() => [{ id: 'sid' }]);
    await withTenant(() => resolveStudentIdForActor(fake.tenantPrisma as never, STUDENT_ACTOR));
    const matching = fake.capture.find(
      (c) =>
        c.sql.includes('FROM sis_students s') &&
        c.sql.includes('JOIN platform.platform_students ps'),
    );
    expect(matching).toBeDefined();
    expect(matching!.sql).toMatch(/s\.school_id\s*=\s*\$2/);
    expect(matching!.args).toEqual([STUDENT_ACTOR.personId, SCHOOL.schoolId]);
  });

  it('isAssignedTeacherOf joins sis_students and requires s.school_id', async () => {
    const fake = makeFake(() => []);
    await withTenant(() =>
      isAssignedTeacherOf(fake.tenantPrisma as never, TEACHER_ACTOR, MAYA_STUDENT_ID),
    );
    const matching = fake.capture.find((c) => c.sql.includes('FROM sis_class_teachers ct'));
    expect(matching).toBeDefined();
    expect(matching!.sql).toMatch(/JOIN sis_students s ON s\.id = e\.student_id/);
    expect(matching!.sql).toMatch(/s\.school_id\s*=\s*\$3/);
    expect(matching!.args[2]).toBe(SCHOOL.schoolId);
  });

  it('isLinkedGuardianOf joins sis_students and requires s.school_id', async () => {
    const fake = makeFake(() => []);
    await withTenant(() =>
      isLinkedGuardianOf(fake.tenantPrisma as never, PARENT_ACTOR, MAYA_STUDENT_ID),
    );
    const matching = fake.capture.find((c) => c.sql.includes('FROM sis_student_guardians sg'));
    expect(matching).toBeDefined();
    expect(matching!.sql).toMatch(/JOIN sis_students s ON s\.id = sg\.student_id/);
    expect(matching!.sql).toMatch(/s\.school_id\s*=\s*\$3/);
    expect(matching!.args[2]).toBe(SCHOOL.schoolId);
  });

  it('isStudentInCurrentSchool returns false for cross-school studentId', async () => {
    const fake = makeFake(() => []); // no rows = not in this school
    const ok = await withTenant(() =>
      isStudentInCurrentSchool(fake.tenantPrisma as never, 'foreign-student'),
    );
    expect(ok).toBe(false);
    const matching = fake.capture.find((c) => c.sql.includes('FROM sis_students'));
    expect(matching!.sql).toMatch(/school_id\s*=\s*\$2/);
  });

  it('isStudentInCurrentSchool returns true for in-school studentId', async () => {
    const fake = makeFake(() => [{ exists: 1 }]);
    const ok = await withTenant(() =>
      isStudentInCurrentSchool(fake.tenantPrisma as never, MAYA_STUDENT_ID),
    );
    expect(ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// R-B3 — Readiness paths school-scoped
// ─────────────────────────────────────────────────────────────

describe('R-B3 — REVIEW-P2C27 BLOCKING 3: readiness paths school-scoped', () => {
  it('assignToStudent refuses cross-school studentId with 400', async () => {
    const fake = makeFake((call) => {
      // pathway exists in this school
      if (
        call.sql.includes('FROM pfl_readiness_pathways p') &&
        call.sql.includes('p.id = $1::uuid')
      ) {
        return [
          {
            id: PATHWAY_ID,
            school_id: SCHOOL.schoolId,
            name: 'Pre-University',
            description: null,
            pathway_type: 'UNIVERSITY_PREP',
            is_active: true,
            milestone_count: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ];
      }
      // milestone list for the pathway
      if (call.sql.includes('FROM pfl_pathway_milestones m')) {
        return [
          {
            id: MILESTONE_ID,
            is_required: true,
            sort_order: 0,
            category: 'OTHER',
            milestone_name: 'M1',
            pathway_id: PATHWAY_ID,
            description: null,
            auto_check_source: null,
          },
        ];
      }
      // isStudentInCurrentSchool — return empty (cross-school)
      if (call.sql.includes('FROM sis_students') && call.sql.includes('WHERE id = $1::uuid')) {
        return [];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new ReadinessPathwayService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck(() => true) as never,
    );
    await expect(
      withTenant(() =>
        svc.assignToStudent(PATHWAY_ID, ADMIN_ACTOR, {
          studentId: 'foreign-student',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('SELECT_ASSIGNMENT_BASE joins through pfl_readiness_pathways with p.school_id predicate', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pfl_student_pathway_assignments a')) {
        return [];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new ReadinessPathwayService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    await withTenant(() => svc.getStudentReadiness(MAYA_STUDENT_ID, ADMIN_ACTOR));
    const matching = fake.capture.find((c) =>
      c.sql.includes('FROM pfl_student_pathway_assignments a'),
    );
    expect(matching).toBeDefined();
    expect(matching!.sql).toMatch(/JOIN pfl_readiness_pathways p ON p\.id = a\.pathway_id/);
    expect(matching!.sql).toMatch(/p\.school_id\s*=\s*\$2/);
    expect(matching!.args).toContain(SCHOOL.schoolId);
  });

  it('getAssignment 404s on cross-school assignmentId (no row returned)', async () => {
    const fake = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new ReadinessPathwayService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck(() => true) as never,
    );
    await expect(
      withTenant(() => svc.getAssignment('foreign-assignment', ADMIN_ACTOR)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─────────────────────────────────────────────────────────────
// R-B4 — College application paths school-scoped
// ─────────────────────────────────────────────────────────────

describe('R-B4 — REVIEW-P2C27 BLOCKING 4: college application paths school-scoped', () => {
  it('getById 404s on cross-school applicationId', async () => {
    const fake = makeFake(() => []);
    const svc = new CollegeApplicationService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(withTenant(() => svc.getById('foreign-app', ADMIN_ACTOR))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('list joins sis_students with s.school_id predicate', async () => {
    const fake = makeFake(() => []);
    const svc = new CollegeApplicationService(fake.tenantPrisma as never, makePermCheck() as never);
    await withTenant(() => svc.listForStudent(MAYA_STUDENT_ID, ADMIN_ACTOR));
    const matching = fake.capture.find((c) => c.sql.includes('FROM pfl_college_applications a'));
    expect(matching).toBeDefined();
    expect(matching!.sql).toMatch(/JOIN sis_students s ON s\.id = a\.student_id/);
    expect(matching!.sql).toMatch(/s\.school_id\s*=\s*\$2/);
    expect(matching!.args).toContain(SCHOOL.schoolId);
  });

  it('create refuses cross-school studentId with 400', async () => {
    const fake = makeFake((call) => {
      // isStudentInCurrentSchool returns empty
      if (call.sql.includes('FROM sis_students') && call.sql.includes('WHERE id = $1::uuid')) {
        return [];
      }
      return [];
    });
    const svc = new CollegeApplicationService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      withTenant(() =>
        svc.create(ADMIN_ACTOR, {
          studentId: 'foreign-student',
          collegeName: 'Stanford',
          applicationType: 'REGULAR_DECISION',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('patch UPDATE statement joins through sis_students with s.school_id predicate', async () => {
    const fake = makeFake((call) => {
      // lock fetch
      if (
        call.sql.includes('FROM pfl_college_applications a') &&
        call.sql.includes('FOR UPDATE OF a')
      ) {
        return [{ id: APP_ID, student_id: MAYA_STUDENT_ID, status: 'APPLIED' }];
      }
      // reload after update
      if (call.sql.includes('FROM pfl_college_applications a')) {
        return [
          {
            id: APP_ID,
            student_id: MAYA_STUDENT_ID,
            student_name: 'Maya',
            college_name: 'Stanford',
            application_type: 'REGULAR_DECISION',
            deadline: null,
            status: 'APPLIED',
            essay_s3_key: null,
            recommendation_count: 0,
            transcript_sent: false,
            financial_aid_applied: false,
            notes: 'updated',
            decision_date: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new CollegeApplicationService(fake.tenantPrisma as never, makePermCheck() as never);
    await withTenant(() => svc.patch(APP_ID, ADMIN_ACTOR, { notes: 'updated' }));
    const updateCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE pfl_college_applications'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toMatch(/FROM sis_students s/);
    expect(updateCall!.sql).toMatch(/s\.school_id\s*=\s*\$\d+/);
  });

  it('listUpcomingDeadlines requires counsellor scope and joins through s.school_id', async () => {
    const fake = makeFake(() => []);
    const svc = new CollegeApplicationService(
      fake.tenantPrisma as never,
      makePermCheck((_, codes) => codes.some((c) => c === 'ach-003:write')) as never,
    );
    await withTenant(() => svc.listUpcomingDeadlines(COUNSELLOR_ACTOR));
    const matching = fake.capture.find((c) => c.sql.includes('FROM pfl_college_applications a'));
    expect(matching).toBeDefined();
    expect(matching!.sql).toMatch(/s\.school_id\s*=\s*\$1/);
    expect(matching!.args[0]).toBe(SCHOOL.schoolId);
  });

  it('listUpcomingDeadlines refuses non-counsellor with 403', async () => {
    const fake = makeFake(() => []);
    const svc = new CollegeApplicationService(
      fake.tenantPrisma as never,
      makePermCheck(() => false) as never,
    );
    await expect(withTenant(() => svc.listUpcomingDeadlines(TEACHER_ACTOR))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// R-B5 — Section + endorsement update/delete carry school predicate
// ─────────────────────────────────────────────────────────────

describe('R-B5 — REVIEW-P2C27 BLOCKING 5: section + endorsement update/delete school-scoped', () => {
  it('section patch UPDATE joins through pfl_portfolios with p.school_id predicate', async () => {
    const fake = makeFake((call) => {
      // lock-and-load
      if (
        call.sql.includes('FROM pfl_portfolio_sections s') &&
        call.sql.includes('FOR UPDATE OF s')
      ) {
        return [
          {
            id: SECTION_ID,
            portfolio_id: PORTFOLIO_ID,
            student_id: MAYA_STUDENT_ID,
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      // reload after update
      if (call.sql.includes('FROM pfl_portfolio_sections s')) {
        return [
          {
            id: SECTION_ID,
            portfolio_id: PORTFOLIO_ID,
            title: 'Updated',
            description: null,
            sort_order: 1,
            cover_image_s3_key: null,
            item_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new PortfolioSectionService(fake.tenantPrisma as never);
    await withTenant(() => svc.patch(SECTION_ID, ADMIN_ACTOR, { title: 'Updated' }));
    const updateCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE pfl_portfolio_sections'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toMatch(/FROM pfl_portfolios p/);
    expect(updateCall!.sql).toMatch(/p\.school_id\s*=\s*\$\d+/);
  });

  it('section remove DELETE joins through pfl_portfolios with p.school_id predicate', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pfl_portfolio_sections s')) {
        return [{ student_id: MAYA_STUDENT_ID, school_id: SCHOOL.schoolId }];
      }
      return [];
    });
    const svc = new PortfolioSectionService(fake.tenantPrisma as never);
    await withTenant(() => svc.remove(SECTION_ID, ADMIN_ACTOR));
    const deleteCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.includes('DELETE FROM pfl_portfolio_sections'),
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.sql).toMatch(/USING pfl_portfolios p/);
    expect(deleteCall!.sql).toMatch(/p\.school_id\s*=\s*\$2/);
  });

  it('endorsement updateVisibility UPDATE joins pfl_portfolios with p.school_id predicate', async () => {
    const fake = makeFake((call) => {
      // lock fetch
      if (call.sql.includes('FROM pfl_endorsements e') && call.sql.includes('FOR UPDATE OF e')) {
        return [{ id: ENDORSEMENT_ID, student_id: MAYA_STUDENT_ID }];
      }
      // resolveStudentIdForActor — admin path returns admin's sis_students (none)
      if (
        call.sql.includes('FROM sis_students s') &&
        call.sql.includes('JOIN platform.platform_students ps')
      ) {
        return [];
      }
      // reload
      if (call.sql.includes('FROM pfl_endorsements e')) {
        return [
          {
            id: ENDORSEMENT_ID,
            portfolio_id: PORTFOLIO_ID,
            endorsed_by: 'emp',
            endorsed_by_name: 'Mr Smith',
            endorser_role: 'TEACHER',
            skills: ['leadership'],
            comment: 'great',
            is_visible_on_share: false,
            endorsed_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new EndorsementService(fake.tenantPrisma as never);
    await withTenant(() =>
      svc.updateVisibility(ENDORSEMENT_ID, ADMIN_ACTOR, { isVisibleOnShare: false }),
    );
    const updateCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE pfl_endorsements'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toMatch(/FROM pfl_portfolios p/);
    expect(updateCall!.sql).toMatch(/p\.school_id\s*=\s*\$3/);
  });

  it('endorsement remove DELETE joins pfl_portfolios with p.school_id predicate', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pfl_endorsements e') && call.sql.includes('FOR UPDATE OF e')) {
        return [{ endorsed_by: ADMIN_ACTOR.employeeId }];
      }
      return [];
    });
    const svc = new EndorsementService(fake.tenantPrisma as never);
    await withTenant(() => svc.remove(ENDORSEMENT_ID, ADMIN_ACTOR));
    const deleteCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.includes('DELETE FROM pfl_endorsements'),
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.sql).toMatch(/USING pfl_portfolios p/);
    expect(deleteCall!.sql).toMatch(/p\.school_id\s*=\s*\$2/);
  });
});

// ─────────────────────────────────────────────────────────────
// R-B6 — Resume cross-module aggregation school-scoped
// ─────────────────────────────────────────────────────────────

describe('R-B6 — REVIEW-P2C27 BLOCKING 6: resume cross-module school-scoped', () => {
  it('generatePdf refuses cross-school studentId with 404', async () => {
    const fake = makeFake((call) => {
      // isStudentInCurrentSchool returns empty
      if (call.sql.includes('FROM sis_students') && call.sql.includes('WHERE id = $1::uuid')) {
        return [];
      }
      // resolveStudentIdForActor returns the cross-school student so the
      // ownership pre-check passes and we hit the school-scope guard.
      if (
        call.sql.includes('FROM sis_students s') &&
        call.sql.includes('JOIN platform.platform_students ps')
      ) {
        return [{ id: 'foreign-student' }];
      }
      return [];
    });
    const svc = new ResumeService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      withTenant(() => svc.generatePdf('foreign-student', STUDENT_ACTOR)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('SELECT_RESUME_BASE joins sis_students and requires s.school_id', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sis_students') && call.sql.includes('WHERE id = $1::uuid')) {
        return [{ exists: 1 }];
      }
      if (call.sql.includes('FROM pfl_resume_profiles r')) {
        return [
          {
            id: 'resume-id',
            student_id: MAYA_STUDENT_ID,
            student_name: 'Maya',
            objective_statement: null,
            skills: [],
            work_experience: [],
            extracurriculars: [],
            awards: [],
            service_hours_total: 0,
            references: [],
            pdf_s3_key: null,
            last_generated_at: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new ResumeService(fake.tenantPrisma as never, makePermCheck() as never);
    await withTenant(() => svc.getForStudent(MAYA_STUDENT_ID, ADMIN_ACTOR));
    const matching = fake.capture.find((c) => c.sql.includes('FROM pfl_resume_profiles r'));
    expect(matching).toBeDefined();
    expect(matching!.sql).toMatch(/JOIN sis_students s ON s\.id = r\.student_id/);
    expect(matching!.sql).toMatch(/s\.school_id\s*=\s*\$2/);
    expect(matching!.args).toContain(SCHOOL.schoolId);
  });

  it('generatePdf aggregations all join sis_students with s.school_id predicate', async () => {
    const fake = makeFake((call) => {
      // isStudentInCurrentSchool
      if (call.sql.includes('FROM sis_students') && call.sql.includes('WHERE id = $1::uuid')) {
        return [{ exists: 1 }];
      }
      // lock + reload of resume
      if (call.sql.includes('FROM pfl_resume_profiles r')) {
        return [
          {
            id: 'resume-id',
            student_id: MAYA_STUDENT_ID,
            student_name: 'Maya',
            objective_statement: null,
            skills: ['existing'],
            work_experience: [],
            extracurriculars: [],
            awards: [],
            service_hours_total: 0,
            references: [],
            pdf_s3_key: null,
            last_generated_at: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ];
      }
      // endorsement skills
      if (call.sql.includes('FROM pfl_endorsements e')) return [];
      // service hours
      if (call.sql.includes('FROM sis_service_learning_hours slh')) return [{ total: 5 }];
      // achievements
      if (call.sql.includes('FROM pfl_achievements a')) return [];
      // extracurriculars
      if (call.sql.includes('FROM ext_activity_members em')) return [];
      return [];
    });
    const svc = new ResumeService(fake.tenantPrisma as never, makePermCheck() as never);
    await withTenant(() => svc.generatePdf(MAYA_STUDENT_ID, ADMIN_ACTOR));

    // Endorsements
    const endorsements = fake.capture.find((c) => c.sql.includes('FROM pfl_endorsements e'));
    expect(endorsements).toBeDefined();
    expect(endorsements!.sql).toMatch(/JOIN pfl_portfolios p ON p\.id = e\.portfolio_id/);
    expect(endorsements!.sql).toMatch(/p\.school_id\s*=\s*\$2/);

    // Service hours
    const slh = fake.capture.find((c) => c.sql.includes('FROM sis_service_learning_hours slh'));
    expect(slh).toBeDefined();
    expect(slh!.sql).toMatch(/JOIN sis_students s ON s\.id = slh\.student_id/);
    expect(slh!.sql).toMatch(/s\.school_id\s*=\s*\$2/);

    // Achievements
    const achievements = fake.capture.find((c) => c.sql.includes('FROM pfl_achievements a'));
    expect(achievements).toBeDefined();
    expect(achievements!.sql).toMatch(/JOIN sis_students s ON s\.id = a\.student_id/);
    expect(achievements!.sql).toMatch(/s\.school_id\s*=\s*\$2/);

    // Extracurriculars subquery — sis_students with s.school_id predicate
    const extra = fake.capture.find((c) => c.sql.includes('FROM ext_activity_members em'));
    expect(extra).toBeDefined();
    expect(extra!.sql).toMatch(/FROM sis_students s/);
    expect(extra!.sql).toMatch(/s\.school_id\s*=\s*\$2/);

    // Final UPDATE
    const updateCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE pfl_resume_profiles'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toMatch(/FROM sis_students s/);
    expect(updateCall!.sql).toMatch(/s\.school_id\s*=\s*\$\d+/);
  });
});
