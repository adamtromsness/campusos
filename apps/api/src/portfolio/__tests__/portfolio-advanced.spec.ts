import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '../../tenant/tenant.context';
import { PortfolioSectionService } from '../section.service';
import { ReflectionService } from '../reflection.service';
import { EndorsementService } from '../endorsement.service';
import { ReadinessPathwayService } from '../readiness.service';
import { CollegeApplicationService } from '../college-application.service';
import { ResumeService } from '../resume.service';

/**
 * P2-27 Step 8 — Portfolio Advanced vertical-slice integration tests.
 *
 * Walks the 7 plan scenarios:
 *   S1 Sections — create + reorder + UNIQUE(portfolio, sort_order)
 *   S2 Reflections — STUDENT-OWNED, UNIQUE(item, student), other student blocked
 *   S3 Endorsements — STUDENT-CANNOT-ENDORSE keystone + visibility toggle owner-only
 *   S4 Readiness pathway — milestone status JSONB + overall_progress recompute
 *                          + pfl.pathway.milestone_completed Kafka emit
 *                          + auto-check from cross-module event
 *   S5 College applications — row scope + deadline index + terminal status
 *                             auto-stamps decision_date
 *   S6 Resume — cross-module auto-populate (endorsement skills UNION,
 *                                            service hours SUM,
 *                                            achievements -> awards)
 *   S7 Visibility — student own / counsellor school-wide / parent linked
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

const OTHER_STUDENT_ACTOR = {
  accountId: 'other-account',
  personId: 'ethan-person',
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
const ITEM_ID = 'item-id';
const PATHWAY_ID = 'pathway-id';

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

function makeKafka() {
  // Legacy alias from before REVIEW-P2C27 BLOCKING 1 moved emits to the
  // durable outbox. New surface lives in `makeOutbox()`. Kept so tests that
  // never reach an emit path can still inject a minimal kafka-shaped mock.
  const emitted: Array<Record<string, unknown>> = [];
  const kafka = {
    emit: async (opts: Record<string, unknown>) => {
      emitted.push({ ...opts });
    },
  };
  return { kafka, emitted };
}

function makeOutbox() {
  // REVIEW-P2C27 BLOCKING 1 — durable outbox replaces the best-effort Kafka
  // emit for pfl.pathway.milestone_completed. The mock matches the
  // OutboxService.enqueueInTx(tx, opts) shape used by the service.
  const emitted: Array<Record<string, unknown>> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: Record<string, unknown>) => {
      emitted.push({ ...opts });
    },
  };
  return { outbox, emitted };
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
// S1 — Sections
// ─────────────────────────────────────────────────────────────

describe('S1 — Portfolio sections (drag-reorder + UNIQUE)', () => {
  it('rejects student attempting to manage another student portfolio sections', async () => {
    const fake = makeFake((call) => {
      // Loading portfolio for ownership check returns Maya
      if (call.sql.includes('FROM pfl_portfolios')) {
        return [{ student_id: MAYA_STUDENT_ID }];
      }
      // resolveStudentIdForActor returns OTHER_STUDENT_ACTOR's own sis_students.id
      if (call.sql.includes('FROM sis_students s')) {
        return [{ id: 'ethan-student-id' }];
      }
      return [];
    });
    const svc = new PortfolioSectionService(fake.tenantPrisma as never);
    await expect(
      withTenant(() =>
        svc.create(PORTFOLIO_ID, OTHER_STUDENT_ACTOR, {
          title: 'Hacker section',
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admin bypasses ownership check on section create', async () => {
    let inserted = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pfl_portfolios')) {
        return [{ student_id: MAYA_STUDENT_ID }];
      }
      if (call.sql.includes('SELECT COALESCE(MAX(sort_order)')) {
        return [{ max_order: 3 }];
      }
      if (call.sql.includes('INSERT INTO pfl_portfolio_sections')) {
        inserted = true;
        return 1;
      }
      if (call.sql.includes('FROM pfl_portfolio_sections')) {
        return [
          {
            id: 'new-section',
            portfolio_id: PORTFOLIO_ID,
            title: 'Academic',
            description: null,
            sort_order: 4,
            cover_image_s3_key: null,
            item_count: 0,
            created_at: '2026-05-16T00:00:00Z',
            updated_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new PortfolioSectionService(fake.tenantPrisma as never);
    const result = await withTenant(() =>
      svc.create(PORTFOLIO_ID, ADMIN_ACTOR, { title: 'Academic' }),
    );
    expect(inserted).toBe(true);
    expect(result.sortOrder).toBe(4); // MAX(sort_order)+1
  });

  it('AssignItemToSection refuses cross-portfolio section', async () => {
    const fake = makeFake((call) => {
      // Item belongs to portfolio P1, section belongs to portfolio P2
      if (call.sql.includes('FROM pfl_portfolio_items i')) {
        return [
          {
            id: ITEM_ID,
            portfolio_id: 'portfolio-1',
            student_id: MAYA_STUDENT_ID,
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (call.sql.includes('FROM pfl_portfolio_sections')) {
        return [{ portfolio_id: 'portfolio-2' }];
      }
      return [];
    });
    const svc = new PortfolioSectionService(fake.tenantPrisma as never);
    await expect(
      withTenant(() =>
        svc.assignItemToSection(ITEM_ID, ADMIN_ACTOR, {
          sectionId: 'cross-portfolio-section',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────
// S2 — Reflections (STUDENT-OWNED)
// ─────────────────────────────────────────────────────────────

describe('S2 — Reflections (STUDENT-OWNED keystone)', () => {
  it('teacher cannot author a reflection — service-layer 403', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pfl_portfolio_items i')) {
        return [{ student_id: MAYA_STUDENT_ID, visibility: 'TEACHER' }];
      }
      return [];
    });
    const svc = new ReflectionService(fake.tenantPrisma as never);
    await expect(
      withTenant(() =>
        svc.create(ITEM_ID, TEACHER_ACTOR, {
          reflectionText: 'This is my best work',
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('other student cannot author reflection on another student item — collapsed 404', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pfl_portfolio_items i')) {
        return [{ student_id: MAYA_STUDENT_ID, visibility: 'PRIVATE' }];
      }
      // resolveStudentIdForActor for the OTHER student returns Ethan's id
      if (call.sql.includes('FROM sis_students s')) {
        return [{ id: 'ethan-student-id' }];
      }
      return [];
    });
    const svc = new ReflectionService(fake.tenantPrisma as never);
    await expect(
      withTenant(() =>
        svc.create(ITEM_ID, OTHER_STUDENT_ACTOR, {
          reflectionText: 'malicious',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('owning student can write reflection + UNIQUE catch on second write', async () => {
    let insertedOnce = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pfl_portfolio_items i')) {
        return [{ student_id: MAYA_STUDENT_ID, visibility: 'PRIVATE' }];
      }
      if (call.sql.includes('FROM sis_students s')) {
        return [{ id: MAYA_STUDENT_ID }];
      }
      if (call.sql.includes('INSERT INTO pfl_reflections')) {
        if (insertedOnce) {
          const err: { code: string; meta: { code: string } } = {
            code: 'P2010',
            meta: { code: '23505' },
          };
          throw err;
        }
        insertedOnce = true;
        return 1;
      }
      if (call.sql.includes('FROM pfl_reflections')) {
        return [
          {
            id: 'refl-1',
            portfolio_item_id: ITEM_ID,
            student_id: MAYA_STUDENT_ID,
            prompt: null,
            reflection_text: 'first reflection',
            written_at: '2026-05-16',
            updated_at: '2026-05-16',
          },
        ];
      }
      return [];
    });
    const svc = new ReflectionService(fake.tenantPrisma as never);
    const r1 = await withTenant(() =>
      svc.create(ITEM_ID, STUDENT_ACTOR, { reflectionText: 'first reflection' }),
    );
    expect(r1.reflectionText).toBe('first reflection');
    await expect(
      withTenant(() => svc.create(ITEM_ID, STUDENT_ACTOR, { reflectionText: 'duplicate' })),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// ─────────────────────────────────────────────────────────────
// S3 — Endorsements (STUDENT-CANNOT keystone)
// ─────────────────────────────────────────────────────────────

describe('S3 — Endorsements (STUDENT-CANNOT-ENDORSE keystone)', () => {
  it('student personType cannot endorse — explicit 403', async () => {
    const fake = makeFake(() => []);
    const svc = new EndorsementService(fake.tenantPrisma as never);
    await expect(
      withTenant(() =>
        svc.create(PORTFOLIO_ID, STUDENT_ACTOR, {
          endorserRole: 'TEACHER',
          skills: ['Critical Thinking'],
          comment: 'Strong work',
        }),
      ),
    ).rejects.toThrowError(/Students cannot endorse/);
  });

  it('guardian cannot endorse either', async () => {
    const fake = makeFake(() => []);
    const svc = new EndorsementService(fake.tenantPrisma as never);
    await expect(
      withTenant(() =>
        svc.create(PORTFOLIO_ID, PARENT_ACTOR, {
          endorserRole: 'TEACHER',
          skills: ['Communication'],
          comment: 'Proud parent',
        }),
      ),
    ).rejects.toThrowError(/Guardians cannot endorse/);
  });

  it('teacher writes endorsement; second endorsement same teacher caught by UNIQUE', async () => {
    let insertedOnce = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pfl_portfolios')) {
        return [{ student_id: MAYA_STUDENT_ID, visibility: 'TEACHER' }];
      }
      if (call.sql.includes('FROM sis_class_teachers ct')) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('INSERT INTO pfl_endorsements')) {
        if (insertedOnce) {
          throw { code: 'P2010', meta: { code: '23505' } };
        }
        insertedOnce = true;
        return 1;
      }
      if (call.sql.includes('FROM pfl_endorsements')) {
        return [
          {
            id: 'end-1',
            portfolio_id: PORTFOLIO_ID,
            endorsed_by: 'teacher-emp',
            endorsed_by_name: 'James Rivera',
            endorser_role: 'TEACHER',
            skills: ['Critical Thinking'],
            comment: 'Strong work',
            is_visible_on_share: true,
            endorsed_at: '2026-05-16',
            updated_at: '2026-05-16',
          },
        ];
      }
      return [];
    });
    const svc = new EndorsementService(fake.tenantPrisma as never);
    const e1 = await withTenant(() =>
      svc.create(PORTFOLIO_ID, TEACHER_ACTOR, {
        endorserRole: 'TEACHER',
        skills: ['Critical Thinking'],
        comment: 'Strong work',
      }),
    );
    expect(e1.skills).toEqual(['Critical Thinking']);
    await expect(
      withTenant(() =>
        svc.create(PORTFOLIO_ID, TEACHER_ACTOR, {
          endorserRole: 'TEACHER',
          skills: ['Perseverance'],
          comment: 'Updated',
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('teacher TEACHER endorsement requires assigned-teacher relationship', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pfl_portfolios')) {
        return [{ student_id: MAYA_STUDENT_ID, visibility: 'TEACHER' }];
      }
      // Unrelated teacher — no sis_class_teachers row
      if (call.sql.includes('FROM sis_class_teachers ct')) {
        return [];
      }
      return [];
    });
    const svc = new EndorsementService(fake.tenantPrisma as never);
    await expect(
      withTenant(() =>
        svc.create(PORTFOLIO_ID, TEACHER_ACTOR, {
          endorserRole: 'TEACHER',
          skills: ['Communication'],
          comment: 'Unrelated teacher',
        }),
      ),
    ).rejects.toThrowError(/assigned teachers/);
  });
});

// ─────────────────────────────────────────────────────────────
// S4 — Readiness pathway (milestone progress + Kafka emit)
// ─────────────────────────────────────────────────────────────

describe('S4 — Readiness pathway milestone progress + Kafka emit', () => {
  it('counsellor updates milestone to COMPLETED — recomputes overall_progress + emits', async () => {
    const milestoneIds = ['m1', 'm2', 'm3', 'm4']; // 4 required milestones
    const startStatuses = [
      {
        milestone_id: 'm1',
        status: 'COMPLETED',
        completed_at: '2026-05-01',
        notes: null,
        progress_detail: null,
      },
      {
        milestone_id: 'm2',
        status: 'NOT_STARTED',
        completed_at: null,
        notes: null,
        progress_detail: null,
      },
      {
        milestone_id: 'm3',
        status: 'NOT_STARTED',
        completed_at: null,
        notes: null,
        progress_detail: null,
      },
      {
        milestone_id: 'm4',
        status: 'NOT_STARTED',
        completed_at: null,
        notes: null,
        progress_detail: null,
      },
    ];
    let storedStatuses: unknown = null;
    let storedProgress: unknown = null;
    const { outbox, emitted } = makeOutbox();
    const fake = makeFake((call) => {
      // Locked-row read of assignment
      if (
        call.sql.includes('FROM pfl_student_pathway_assignments a') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [
          {
            id: 'assign-1',
            student_id: MAYA_STUDENT_ID,
            pathway_id: PATHWAY_ID,
            milestone_statuses: startStatuses,
            overall_progress: 25,
            status: 'ACTIVE',
            p_school_id: SCHOOL.schoolId,
          },
        ];
      }
      // Milestone belongs-to-pathway probe. REVIEW-P2C27 BLOCKING 3 joins
      // through pfl_readiness_pathways so the new SQL shape is `FROM
      // pfl_pathway_milestones m JOIN pfl_readiness_pathways p ON ... WHERE
      // m.id = $1 AND m.pathway_id = $2 AND p.school_id = $3`.
      if (
        call.sql.includes('FROM pfl_pathway_milestones WHERE id =') ||
        call.sql.includes('FROM pfl_pathway_milestones m WHERE m.id =') ||
        (call.sql.includes('FROM pfl_pathway_milestones m') &&
          call.sql.includes('m.id = $1::uuid') &&
          call.sql.includes('m.pathway_id = $2::uuid'))
      ) {
        return [{ id: 'm2', is_required: true, milestone_name: 'AP courses' }];
      }
      // All-milestones-for-pathway probe (progress denominator). The new
      // SQL is `FROM pfl_pathway_milestones m JOIN pfl_readiness_pathways p
      // WHERE m.pathway_id = $1 AND p.school_id = $2`.
      if (
        call.sql.includes('FROM pfl_pathway_milestones m WHERE pathway_id') ||
        call.sql.includes('FROM pfl_pathway_milestones WHERE pathway_id') ||
        (call.sql.includes('FROM pfl_pathway_milestones m') &&
          call.sql.includes('m.pathway_id = $1::uuid'))
      ) {
        return milestoneIds.map((id) => ({ id, is_required: true }));
      }
      if (call.sql.includes('SELECT milestone_name FROM pfl_pathway_milestones')) {
        return [{ milestone_name: 'AP courses completed' }];
      }
      if (call.sql.includes('UPDATE pfl_student_pathway_assignments')) {
        storedStatuses = call.args[0];
        storedProgress = call.args[1];
        return 1;
      }
      // Final reload
      if (call.sql.includes('FROM pfl_student_pathway_assignments a')) {
        return [
          {
            id: 'assign-1',
            student_id: MAYA_STUDENT_ID,
            student_name: 'Maya Chen',
            pathway_id: PATHWAY_ID,
            pathway_name: 'College Prep',
            pathway_type: 'COLLEGE_PREP',
            assigned_by: 'cou-emp',
            assigned_by_name: 'Marcus Hayes',
            assigned_at: '2026-04-01',
            milestone_statuses: JSON.parse(String(storedStatuses ?? '[]')),
            overall_progress: storedProgress,
            status: 'ACTIVE',
            notes: null,
            updated_at: '2026-05-16',
          },
        ];
      }
      // resolveStudentIdForActor for counsellor (STAFF) returns null
      if (call.sql.includes('FROM sis_students s')) {
        return [];
      }
      // SELECT_MILESTONE_BASE for assignmentRowToDto
      if (call.sql.includes('FROM pfl_pathway_milestones m WHERE m.pathway_id')) {
        return milestoneIds.map((id, idx) => ({
          id,
          pathway_id: PATHWAY_ID,
          milestone_name: 'M' + (idx + 1),
          description: null,
          category: 'ACADEMIC',
          sort_order: idx + 1,
          is_required: true,
          auto_check_source: null,
        }));
      }
      return [];
    });
    const perm = makePermCheck((_a, codes) => codes.includes('ach-003:write'));
    const svc = new ReadinessPathwayService(fake.tenantPrisma as never, outbox as never, perm);
    const result = await withTenant(() =>
      svc.updateMilestoneStatus('assign-1', COUNSELLOR_ACTOR, {
        milestoneId: 'm2',
        status: 'COMPLETED',
      }),
    );
    // 2 / 4 required = 50%
    expect(Number(storedProgress)).toBe(50);
    // Kafka emit fired
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.topic).toBe('pfl.pathway.milestone_completed');
    expect(emitted[0]!.sourceModule).toBe('portfolio');
    const payload = emitted[0]!.payload as Record<string, unknown>;
    expect(payload.milestoneId).toBe('m2');
    expect(payload.studentId).toBe(MAYA_STUDENT_ID);
    expect(payload.overallProgress).toBe(50);
    // Result picks up the new progress
    expect(result.overallProgress).toBe(50);
  });

  it('student cannot update milestone if not own pathway assignment', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM pfl_student_pathway_assignments a') &&
        call.sql.includes('FOR UPDATE')
      ) {
        // Assignment is for Maya, but the calling student is Ethan
        return [
          {
            id: 'assign-1',
            student_id: MAYA_STUDENT_ID,
            pathway_id: PATHWAY_ID,
            milestone_statuses: [],
            overall_progress: 0,
            status: 'ACTIVE',
          },
        ];
      }
      if (call.sql.includes('FROM sis_students s')) {
        // Ethan's own sis_students.id
        return [{ id: 'ethan-student-id' }];
      }
      return [];
    });
    const perm = makePermCheck(() => false);
    const svc = new ReadinessPathwayService(
      fake.tenantPrisma as never,
      { enqueueInTx: async () => undefined } as never,
      perm,
    );
    await expect(
      withTenant(() =>
        svc.updateMilestoneStatus('assign-1', OTHER_STUDENT_ACTOR, {
          milestoneId: 'm2',
          status: 'COMPLETED',
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('autoCheckByCrossModuleEvent walks matching milestones + emits pfl.pathway.milestone_completed', async () => {
    const { outbox, emitted } = makeOutbox();
    let updateCalled = false;
    const fake = makeFake((call) => {
      // Locked walk-and-update of matching milestones
      if (call.sql.includes('auto_check_source = $3') && call.sql.includes('FOR UPDATE')) {
        return [
          {
            id: 'assign-1',
            pathway_id: PATHWAY_ID,
            milestone_statuses: [
              {
                milestone_id: 'service-milestone',
                status: 'NOT_STARTED',
                completed_at: null,
                notes: null,
                progress_detail: null,
              },
            ],
            status: 'ACTIVE',
            milestone_id: 'service-milestone',
            milestone_name: 'Community service 40 hours',
          },
        ];
      }
      if (call.sql.includes('FROM pfl_pathway_milestones WHERE pathway_id')) {
        return [{ id: 'service-milestone', is_required: true }];
      }
      if (call.sql.includes('UPDATE pfl_student_pathway_assignments')) {
        updateCalled = true;
        return 1;
      }
      return [];
    });
    const svc = new ReadinessPathwayService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck(() => true),
    );
    const count = await withTenant(() =>
      svc.autoCheckByCrossModuleEvent(
        SCHOOL.schoolId,
        MAYA_STUDENT_ID,
        'graduation_audit:SERVICE_HOURS',
      ),
    );
    expect(updateCalled).toBe(true);
    expect(count).toBe(1);
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.topic).toBe('pfl.pathway.milestone_completed');
    expect((emitted[0]!.payload as Record<string, unknown>).autoCheckSource).toBe(
      'graduation_audit:SERVICE_HOURS',
    );
  });
});

// ─────────────────────────────────────────────────────────────
// S5 — College applications (row scope + deadlines)
// ─────────────────────────────────────────────────────────────

describe('S5 — College applications', () => {
  it('student creates application defaulting to own studentId', async () => {
    let insertArgs: unknown[] = [];
    const fake = makeFake((call) => {
      // Check the table-specific match BEFORE the generic sis_students match
      // because SELECT_APP_BASE has a sis_students subquery for student_name.
      if (call.sql.includes('INSERT INTO pfl_college_applications')) {
        insertArgs = call.args;
        return 1;
      }
      if (call.sql.includes('FROM pfl_college_applications a')) {
        return [
          {
            id: 'app-1',
            student_id: MAYA_STUDENT_ID,
            student_name: 'Maya Chen',
            college_name: 'Stanford',
            application_type: 'REGULAR',
            deadline: '2027-01-02',
            status: 'RESEARCHING',
            essay_s3_key: null,
            recommendation_count: 0,
            transcript_sent: false,
            financial_aid_applied: false,
            notes: null,
            decision_date: null,
            created_at: '2026-05-16',
            updated_at: '2026-05-16',
          },
        ];
      }
      // REVIEW-P2C27 BLOCKING 4 — isStudentInCurrentSchool probe runs before
      // INSERT. Matches `FROM sis_students WHERE id = $1::uuid AND school_id`.
      if (call.sql.includes('FROM sis_students WHERE id =')) {
        return [{ exists: 1 }];
      }
      if (call.sql.includes('FROM sis_students s')) {
        return [{ id: MAYA_STUDENT_ID }];
      }
      return [];
    });
    const svc = new CollegeApplicationService(
      fake.tenantPrisma as never,
      makePermCheck(() => false),
    );
    const result = await withTenant(() =>
      svc.create(STUDENT_ACTOR, {
        collegeName: 'Stanford',
        applicationType: 'REGULAR',
        deadline: '2027-01-02',
      }),
    );
    expect(result.studentId).toBe(MAYA_STUDENT_ID);
    // Verify the INSERT used Maya's student id as $2
    expect(insertArgs[1]).toBe(MAYA_STUDENT_ID);
  });

  it('PATCH to ACCEPTED auto-stamps decision_date when not supplied', async () => {
    const fake = makeFake((call) => {
      // Locked-row pre-check
      if (call.sql.includes('FOR UPDATE') && call.sql.includes('pfl_college_applications')) {
        return [
          {
            id: 'app-1',
            student_id: MAYA_STUDENT_ID,
            status: 'SUBMITTED',
          },
        ];
      }
      if (call.sql.includes('FROM sis_students s')) {
        return [{ id: MAYA_STUDENT_ID }];
      }
      if (call.sql.includes('FROM pfl_college_applications a')) {
        return [
          {
            id: 'app-1',
            student_id: MAYA_STUDENT_ID,
            student_name: 'Maya Chen',
            college_name: 'KSU',
            application_type: 'ROLLING',
            deadline: '2026-12-15',
            status: 'ACCEPTED',
            essay_s3_key: null,
            recommendation_count: 2,
            transcript_sent: true,
            financial_aid_applied: false,
            notes: null,
            decision_date: '2026-04-16',
            created_at: '2026-05-16',
            updated_at: '2026-05-16',
          },
        ];
      }
      return [];
    });
    const svc = new CollegeApplicationService(
      fake.tenantPrisma as never,
      makePermCheck(() => false),
    );
    let capturedUpdateSql = '';
    fake.client.$executeRawUnsafe = (async (sql: string, ...args: unknown[]) => {
      if (sql.includes('UPDATE pfl_college_applications')) {
        capturedUpdateSql = sql;
      }
      fake.capture.push({ sql, args, fn: 'e' });
      return 1;
    }) as never;
    await withTenant(() => svc.patch('app-1', STUDENT_ACTOR, { status: 'ACCEPTED' }));
    expect(capturedUpdateSql).toContain('decision_date = CURRENT_DATE');
  });

  it('counsellor sees school-wide upcoming deadlines, students refused', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pfl_college_applications a')) {
        return [
          {
            id: 'app-1',
            student_id: MAYA_STUDENT_ID,
            student_name: 'Maya Chen',
            college_name: 'Stanford',
            application_type: 'REGULAR',
            deadline: '2027-01-02',
            status: 'RESEARCHING',
            essay_s3_key: null,
            recommendation_count: 0,
            transcript_sent: false,
            financial_aid_applied: false,
            notes: null,
            decision_date: null,
            created_at: '2026-05-16',
            updated_at: '2026-05-16',
          },
        ];
      }
      return [];
    });
    const svc = new CollegeApplicationService(
      fake.tenantPrisma as never,
      makePermCheck(
        (_a, codes) => codes.includes('ach-003:write') || codes.includes('ach-003:admin'),
      ),
    );
    const list = await withTenant(() => svc.listUpcomingDeadlines(COUNSELLOR_ACTOR));
    expect(list.length).toBe(1);
    // Student attempt with no counsellor scope is refused
    const studentSvc = new CollegeApplicationService(
      fake.tenantPrisma as never,
      makePermCheck(() => false),
    );
    await expect(
      withTenant(() => studentSvc.listUpcomingDeadlines(STUDENT_ACTOR)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ─────────────────────────────────────────────────────────────
// S6 — Resume cross-module auto-populate
// ─────────────────────────────────────────────────────────────

describe('S6 — Resume PDF generation cross-module auto-populate', () => {
  it('skills UNION endorsements; service hours from sis; awards from pfl_achievements', async () => {
    let updateArgs: unknown[] = [];
    const fake = makeFake((call) => {
      if (call.sql.includes('FOR UPDATE') && call.sql.includes('pfl_resume_profiles')) {
        return [
          {
            id: 'resume-1',
            student_id: MAYA_STUDENT_ID,
            student_name: 'Maya Chen',
            objective_statement: 'Aspiring researcher',
            skills: ['Leadership'], // self-reported
            work_experience: [],
            extracurriculars: [],
            awards: [],
            service_hours_total: 0,
            references: [],
            pdf_s3_key: null,
            last_generated_at: null,
            created_at: '2026-05-16',
            updated_at: '2026-05-16',
          },
        ];
      }
      // REVIEW-P2C27 BLOCKING 6 — every cross-module aggregation joins
      // through sis_students with s.school_id. Match the specific tables
      // BEFORE the generic `FROM sis_students s` fallback because the new
      // UPDATE statement also contains `FROM sis_students s` and we need
      // to capture its args, not short-circuit on the JOIN.
      if (call.sql.includes('UPDATE pfl_resume_profiles')) {
        updateArgs = call.args;
        return 1;
      }
      if (call.sql.includes('FROM pfl_endorsements e')) {
        return [{ skill: 'Critical Thinking' }, { skill: 'Written Communication' }];
      }
      if (call.sql.includes('FROM sis_service_learning_hours')) {
        return [{ total: 42.5 }];
      }
      if (call.sql.includes('FROM pfl_achievements')) {
        return [
          { title: 'Outstanding Writer', type: 'ACADEMIC', awarded_at: '2026-05-01' },
          { title: 'Summer Reading Champion', type: 'COMMUNITY', awarded_at: '2026-08-15' },
        ];
      }
      if (call.sql.includes('FROM ext_activity_members em')) {
        return [{ activity: 'Debate Club', role: 'Vice President', joined_at: '2025-09-01' }];
      }
      // REVIEW-P2C27 BLOCKING 6 — isStudentInCurrentSchool probe matches
      // `FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid`.
      if (call.sql.includes('FROM sis_students WHERE id =')) {
        return [{ exists: 1 }];
      }
      // resolveStudentIdForActor fallback — match last because all of the
      // SQL above ALSO references `JOIN sis_students s` (or `FROM sis_students s`
      // as a subquery), and we only want this matcher to fire for the
      // platform_students-bridge query in portfolio-access.ts.
      if (call.sql.includes('FROM sis_students s')) {
        return [{ id: MAYA_STUDENT_ID }];
      }
      return [];
    });
    const svc = new ResumeService(
      fake.tenantPrisma as never,
      makePermCheck(() => false),
    );
    const result = await withTenant(() => svc.generatePdf(MAYA_STUDENT_ID, STUDENT_ACTOR));
    expect(result.skillsCount).toBe(3); // Leadership + Critical Thinking + Written Communication
    expect(result.serviceHoursTotal).toBe(42.5);
    expect(result.awardsCount).toBe(2);
    expect(result.extracurricularsCount).toBe(1);
    expect(result.pdfS3Key).toMatch(/^resumes\/maya-student-id\/\d+\.pdf$/);
    // skills argument is the merged array
    const mergedSkills = updateArgs[0] as string[];
    expect(mergedSkills).toContain('Leadership');
    expect(mergedSkills).toContain('Critical Thinking');
    expect(mergedSkills).toContain('Written Communication');
  });

  it('non-owner cannot generate PDF', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sis_students s')) {
        return [{ id: 'ethan-student-id' }];
      }
      return [];
    });
    const svc = new ResumeService(
      fake.tenantPrisma as never,
      makePermCheck(() => false),
    );
    await expect(
      withTenant(() => svc.generatePdf(MAYA_STUDENT_ID, OTHER_STUDENT_ACTOR)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ─────────────────────────────────────────────────────────────
// S7 — Endorsement visibility toggle owner-only
// ─────────────────────────────────────────────────────────────

describe('S7 — Endorsement visibility toggle (student-controlled)', () => {
  it('teacher cannot toggle visibility of their own endorsement — only the student owner', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FOR UPDATE') && call.sql.includes('pfl_endorsements')) {
        return [
          {
            id: 'end-1',
            student_id: MAYA_STUDENT_ID,
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      // Teacher is not Maya — resolveStudentIdForActor returns null for STAFF
      if (call.sql.includes('FROM sis_students s')) {
        return [];
      }
      return [];
    });
    const svc = new EndorsementService(fake.tenantPrisma as never);
    await expect(
      withTenant(() => svc.updateVisibility('end-1', TEACHER_ACTOR, { isVisibleOnShare: false })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('student owner toggles visibility', async () => {
    let updateArgs: unknown[] = [];
    const fake = makeFake((call) => {
      if (call.sql.includes('FOR UPDATE') && call.sql.includes('pfl_endorsements')) {
        return [
          {
            id: 'end-1',
            student_id: MAYA_STUDENT_ID,
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (call.sql.includes('FROM sis_students s')) {
        return [{ id: MAYA_STUDENT_ID }];
      }
      if (call.sql.includes('UPDATE pfl_endorsements')) {
        updateArgs = call.args;
        return 1;
      }
      if (call.sql.includes('FROM pfl_endorsements')) {
        return [
          {
            id: 'end-1',
            portfolio_id: PORTFOLIO_ID,
            endorsed_by: 'teacher-emp',
            endorsed_by_name: 'James Rivera',
            endorser_role: 'TEACHER',
            skills: ['Critical Thinking'],
            comment: 'Great work',
            is_visible_on_share: false,
            endorsed_at: '2026-05-16',
            updated_at: '2026-05-16',
          },
        ];
      }
      return [];
    });
    const svc = new EndorsementService(fake.tenantPrisma as never);
    const result = await withTenant(() =>
      svc.updateVisibility('end-1', STUDENT_ACTOR, { isVisibleOnShare: false }),
    );
    expect(result.isVisibleOnShare).toBe(false);
    // First UPDATE arg was the new visibility flag
    expect(updateArgs[0]).toBe(false);
  });
});
