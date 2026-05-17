import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { StandardGradeService } from './standard-grade.service';
import { PeerReviewService } from './peer-review.service';
import { ObservationService } from './observation.service';
import { FormativeAssessmentService } from './formative-assessment.service';
import { ReportCardSubjectService } from './report-card-subject.service';
import { StandardGradeController } from './standard-grade.controller';
import { PeerReviewController } from './peer-review.controller';
import { ObservationController } from './observation.controller';
import { FormativeAssessmentController } from './formative-assessment.controller';
import { ReportCardSubjectController } from './report-card-subject.controller';

const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-a0000000a001',
  personId: '019e0cf8-bbb8-7556-8c81-a0000000a002',
  employeeId: '019e0cf8-bbb8-7556-8c81-a0000000a003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;

const TEACHER_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-b0000000b001',
  personId: '019e0cf8-bbb8-7556-8c81-b0000000b002',
  employeeId: '019e0cf8-bbb8-7556-8c81-b0000000b003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
} as never;

const STUDENT_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
  personId: '019e0cf8-bbb8-7556-8c81-c0000000c002',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
} as never;

const PARENT_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-d0000000d001',
  personId: '019e0cf8-bbb8-7556-8c81-d0000000d002',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
} as never;

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

// ─────────────────────────────────────────────────────────────────────────────
// PeerReviewService — anonymisation keystone
// ─────────────────────────────────────────────────────────────────────────────
describe('PeerReviewService — anonymisation keystone', () => {
  const SUBMITTED_REVIEW_ROW = {
    id: 'review-1',
    peer_assignment_id: 'pa-1',
    reviewer_student_id: 'student-reviewer-1',
    reviewer_student_name: 'Alex Reviewer',
    reviewee_submission_id: 'sub-1',
    reviewee_student_id: 'student-reviewee-1',
    reviewee_student_name: 'Sam Reviewee',
    feedback: 'Good work.',
    overall_rating: 'GOOD',
    status: 'SUBMITTED',
    submitted_at: new Date(),
    teacher_reviewed_by: null,
    teacher_reviewed_at: null,
    is_anonymous: true,
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('strips reviewer identity when anonymous=true and caller is the reviewee', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_peer_reviews pr')) {
        return [SUBMITTED_REVIEW_ROW];
      }
      // resolveStudentSelfId returns the reviewee's student id
      if (sql.includes('from sis_students s')) {
        return [{ id: 'student-reviewee-1' }];
      }
      return [];
    });
    const svc = new PeerReviewService(fake.tenantPrisma as never);
    const out = await svc.listForSubmission('sub-1', STUDENT_ACTOR);
    expect(out.length).toBe(1);
    expect(out[0]!.reviewerStudentId).toBeNull();
    expect(out[0]!.reviewerStudentName).toBeNull();
    expect(out[0]!.isAnonymousView).toBe(true);
    // Reviewee identity columns are NOT stripped — just the reviewer
    expect(out[0]!.revieweeSubmissionId).toBe('sub-1');
    // The feedback content stays
    expect(out[0]!.feedback).toBe('Good work.');
    expect(out[0]!.overallRating).toBe('GOOD');
  });

  it('keeps reviewer identity for staff/admin viewers (audit access)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_peer_reviews pr')) {
        return [SUBMITTED_REVIEW_ROW];
      }
      return [];
    });
    const svc = new PeerReviewService(fake.tenantPrisma as never);
    const out = await svc.listForSubmission('sub-1', ADMIN_ACTOR);
    expect(out[0]!.reviewerStudentId).toBe('student-reviewer-1');
    expect(out[0]!.reviewerStudentName).toBe('Alex Reviewer');
    expect(out[0]!.isAnonymousView).toBe(false);
  });

  it('keeps reviewer identity for teacher viewers regardless of is_anonymous', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_peer_reviews pr')) {
        return [SUBMITTED_REVIEW_ROW];
      }
      return [];
    });
    const svc = new PeerReviewService(fake.tenantPrisma as never);
    const out = await svc.listForSubmission('sub-1', TEACHER_ACTOR);
    expect(out[0]!.reviewerStudentId).toBe('student-reviewer-1');
    expect(out[0]!.isAnonymousView).toBe(false);
  });

  it('keeps own reviewer identity when the calling student IS the reviewer', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_peer_reviews pr')) {
        return [SUBMITTED_REVIEW_ROW];
      }
      if (sql.includes('from sis_students s')) {
        // Resolve the calling student to the reviewer's id
        return [{ id: 'student-reviewer-1' }];
      }
      return [];
    });
    const svc = new PeerReviewService(fake.tenantPrisma as never);
    const out = await svc.listForSubmission('sub-1', STUDENT_ACTOR);
    expect(out[0]!.reviewerStudentId).toBe('student-reviewer-1');
    expect(out[0]!.reviewerStudentName).toBe('Alex Reviewer');
    expect(out[0]!.isAnonymousView).toBe(false);
  });

  it('does NOT strip identity when assignment is_anonymous=false', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_peer_reviews pr')) {
        return [{ ...SUBMITTED_REVIEW_ROW, is_anonymous: false }];
      }
      if (sql.includes('from sis_students s')) {
        return [{ id: 'student-reviewee-1' }];
      }
      return [];
    });
    const svc = new PeerReviewService(fake.tenantPrisma as never);
    const out = await svc.listForSubmission('sub-1', STUDENT_ACTOR);
    expect(out[0]!.reviewerStudentId).toBe('student-reviewer-1');
    expect(out[0]!.isAnonymousView).toBe(false);
  });

  it('refuses RANDOM assign with too few submissions', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select assignment_id::text as assignment_id, review_type')) {
        return [{ assignment_id: 'asg-1', review_type: 'RANDOM', reviews_per_student: 2 }];
      }
      if (sql.includes('select class_id::text as class_id from cls_assignments')) {
        return [{ class_id: 'class-1' }];
      }
      if (sql.includes('select 1 as ok from sis_class_teachers')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from cls_submissions where assignment_id')) {
        // Only 1 submission — RANDOM mode needs at least 2
        return [{ id: 'sub-1', student_id: 'student-1' }];
      }
      return [];
    });
    const svc = new PeerReviewService(fake.tenantPrisma as never);
    await expect(svc.assignReviews('pa-1', {}, ADMIN_ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('TEACHER_ASSIGNED refuses self-review', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select assignment_id::text as assignment_id, review_type')) {
        return [
          { assignment_id: 'asg-1', review_type: 'TEACHER_ASSIGNED', reviews_per_student: 2 },
        ];
      }
      if (sql.includes('select class_id::text as class_id from cls_assignments')) {
        return [{ class_id: 'class-1' }];
      }
      if (sql.includes('select 1 as ok from sis_class_teachers')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from cls_submissions where assignment_id')) {
        return [
          { id: 'sub-1', student_id: 'student-1' },
          { id: 'sub-2', student_id: 'student-2' },
        ];
      }
      return [];
    });
    const svc = new PeerReviewService(fake.tenantPrisma as never);
    await expect(
      svc.assignReviews(
        'pa-1',
        { manualAssignments: { 'student-1': ['sub-1'] } }, // student-1 reviewing own submission
        ADMIN_ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses non-reviewer non-admin from submitting another student's review", async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select s.id::text as id from sis_students s')) {
        // Calling student is student-x, but the review belongs to student-y
        return [{ id: 'student-x' }];
      }
      if (sql.includes('select status, reviewer_student_id::text')) {
        return [{ status: 'ASSIGNED', reviewer_student_id: 'student-y' }];
      }
      return [];
    });
    const svc = new PeerReviewService(fake.tenantPrisma as never);
    await expect(svc.submit('review-1', { feedback: 'x' }, STUDENT_ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ObservationService — parent visibility gate
// ─────────────────────────────────────────────────────────────────────────────
describe('ObservationService — parent visibility gate', () => {
  it('admin sees all observations for a student', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_student_observations o')) {
        return [
          {
            id: 'obs-1',
            class_id: 'class-1',
            class_name: 'Math (P1)',
            student_id: 'student-1',
            student_name: 'Maya',
            teacher_id: 'teacher-1',
            teacher_name: 'Rivera',
            note_text: 'Great work.',
            note_type: 'COMMENDATION',
            is_shared_with_parent: true,
            created_at: new Date(),
            updated_at: new Date(),
          },
          {
            id: 'obs-2',
            class_id: 'class-1',
            class_name: 'Math (P1)',
            student_id: 'student-1',
            student_name: 'Maya',
            teacher_id: 'teacher-1',
            teacher_name: 'Rivera',
            note_text: 'Internal concern note',
            note_type: 'CONCERN',
            is_shared_with_parent: false,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new ObservationService(fake.tenantPrisma as never);
    const out = await svc.listForStudent('student-1', ADMIN_ACTOR);
    expect(out.length).toBe(2);
  });

  it('linked guardian sees only is_shared_with_parent=true rows', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_student_guardians sg')) {
        return [{ ok: 1 }];
      }
      if (
        sql.includes('from cls_student_observations o') &&
        sql.includes('is_shared_with_parent = true')
      ) {
        return [
          {
            id: 'obs-1',
            class_id: 'class-1',
            class_name: 'Math (P1)',
            student_id: 'student-1',
            student_name: 'Maya',
            teacher_id: 'teacher-1',
            teacher_name: 'Rivera',
            note_text: 'Great work.',
            note_type: 'COMMENDATION',
            is_shared_with_parent: true,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new ObservationService(fake.tenantPrisma as never);
    const out = await svc.listForStudent('student-1', PARENT_ACTOR);
    expect(out.length).toBe(1);
    expect(out[0]!.isSharedWithParent).toBe(true);
    // Verify the SQL filter was applied
    const sharedWhereCall = fake.capture.find((c) =>
      c.sql.includes('is_shared_with_parent = true'),
    );
    expect(sharedWhereCall).toBeDefined();
  });

  it('non-linked guardian sees empty list', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_student_guardians sg')) {
        return []; // not linked
      }
      return [];
    });
    const svc = new ObservationService(fake.tenantPrisma as never);
    const out = await svc.listForStudent('student-1', PARENT_ACTOR);
    expect(out.length).toBe(0);
  });

  it('students never see observations about themselves', async () => {
    const fake = makeFake(() => []);
    const svc = new ObservationService(fake.tenantPrisma as never);
    const out = await svc.listForStudent('student-1', STUDENT_ACTOR);
    expect(out.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// StandardGradeService — evidence type validation + standard catalogue
// resolution
// ─────────────────────────────────────────────────────────────────────────────
describe('StandardGradeService — evidence + dual-catalogue resolution', () => {
  it('refuses SUBMISSION evidence without evidenceRefId', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select class_id::text as class_id from cls_standard_grades')) {
        return [{ class_id: 'class-1' }];
      }
      if (sql.includes('select 1 as ok from sis_classes')) {
        return [{ ok: 1 }];
      }
      return [];
    });
    const svc = new StandardGradeService(fake.tenantPrisma as never);
    await expect(
      svc.addEvidence('sg-1', { evidenceType: 'SUBMISSION' as never }, ADMIN_ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses ASSESSMENT evidence with bogus evidenceRefId', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select class_id::text as class_id from cls_standard_grades')) {
        return [{ class_id: 'class-1' }];
      }
      if (sql.includes('select 1 as ok from sis_classes')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from cls_grades where id =')) {
        return []; // bogus id — empty
      }
      return [];
    });
    const svc = new StandardGradeService(fake.tenantPrisma as never);
    await expect(
      svc.addEvidence(
        'sg-1',
        {
          evidenceType: 'ASSESSMENT' as never,
          evidenceRefId: 'bogus-id',
        },
        ADMIN_ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('OBSERVATION evidence accepts no evidenceRefId', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select class_id::text as class_id from cls_standard_grades')) {
        return [{ class_id: 'class-1' }];
      }
      if (sql.includes('select 1 as ok from sis_classes')) {
        return [{ ok: 1 }];
      }
      // After insert, the SELECT to build the response DTO
      if (sql.includes('from cls_standard_grade_evidence where id =')) {
        return [
          {
            id: 'ev-1',
            standard_grade_id: 'sg-1',
            evidence_type: 'OBSERVATION',
            evidence_ref_id: null,
            description: 'Observed in class',
            added_by: 'teacher-1',
            added_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new StandardGradeService(fake.tenantPrisma as never);
    const out = await svc.addEvidence(
      'sg-1',
      {
        evidenceType: 'OBSERVATION' as never,
        description: 'Observed in class',
      },
      ADMIN_ACTOR,
    );
    expect(out.evidenceType).toBe('OBSERVATION');
    expect(out.evidenceRefId).toBeNull();
  });

  it('rejects standard_id that does not resolve in either catalogue', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes("select 'tenant' as src from cur_standards")) {
        return []; // not in either catalogue
      }
      if (sql.includes('select 1 as ok from sis_classes')) {
        return [{ ok: 1 }];
      }
      return [];
    });
    const svc = new StandardGradeService(fake.tenantPrisma as never);
    await expect(
      svc.upsert(
        {
          studentId: 'student-1',
          standardId: 'bogus-standard',
          classId: 'class-1',
          proficiencyLevel: 'MEETING' as never,
        },
        ADMIN_ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FormativeAssessmentService — activation lifecycle
// ─────────────────────────────────────────────────────────────────────────────
describe('FormativeAssessmentService — activation lifecycle', () => {
  it('refuses double-activate', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes(
          'select class_id::text as class_id, created_by::text as created_by, is_active, closed_at',
        )
      ) {
        return [
          {
            class_id: 'class-1',
            created_by: TEACHER_ACTOR.employeeId,
            is_active: true,
            closed_at: null,
          },
        ];
      }
      return [];
    });
    const svc = new FormativeAssessmentService(fake.tenantPrisma as never);
    await expect(svc.activate('asm-1', TEACHER_ACTOR)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses activate after close (no reactivation)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes(
          'select class_id::text as class_id, created_by::text as created_by, is_active, closed_at',
        )
      ) {
        return [
          {
            class_id: 'class-1',
            created_by: TEACHER_ACTOR.employeeId,
            is_active: false,
            closed_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new FormativeAssessmentService(fake.tenantPrisma as never);
    await expect(svc.activate('asm-1', TEACHER_ACTOR)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses activate by non-author non-admin', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes(
          'select class_id::text as class_id, created_by::text as created_by, is_active, closed_at',
        )
      ) {
        return [
          {
            class_id: 'class-1',
            created_by: 'someone-else',
            is_active: false,
            closed_at: null,
          },
        ];
      }
      return [];
    });
    const svc = new FormativeAssessmentService(fake.tenantPrisma as never);
    await expect(svc.activate('asm-1', TEACHER_ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses student response when assessment not active', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select s.id::text as id from sis_students s')) {
        return [{ id: 'student-1' }];
      }
      if (
        sql.includes('select class_id::text as class_id, is_active from cls_formative_assessments')
      ) {
        return [{ class_id: 'class-1', is_active: false }];
      }
      return [];
    });
    const svc = new FormativeAssessmentService(fake.tenantPrisma as never);
    await expect(
      svc.submitResponse('asm-1', { responses: { q1: '5' } }, STUDENT_ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses non-student non-admin from submitting', async () => {
    const fake = makeFake(() => []);
    const svc = new FormativeAssessmentService(fake.tenantPrisma as never);
    await expect(
      svc.submitResponse('asm-1', { responses: { q1: '5' } }, TEACHER_ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('students see only ACTIVE assessments in class list', async () => {
    let capturedSql = '';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_formative_assessments fa')) {
        capturedSql = c.sql;
        return [];
      }
      return [];
    });
    const svc = new FormativeAssessmentService(fake.tenantPrisma as never);
    await svc.listForClass('class-1', STUDENT_ACTOR);
    expect(capturedSql).toContain('fa.is_active = true');
  });

  it('staff/admin see all states in class list', async () => {
    let capturedSql = '';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_formative_assessments fa')) {
        capturedSql = c.sql;
        return [];
      }
      return [];
    });
    const svc = new FormativeAssessmentService(fake.tenantPrisma as never);
    await svc.listForClass('class-1', ADMIN_ACTOR);
    expect(capturedSql).not.toContain('is_active = true');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReportCardSubjectService — class-teacher gating
// ─────────────────────────────────────────────────────────────────────────────
describe('ReportCardSubjectService — class-teacher gating', () => {
  it('refuses non-teacher of the class to add a subject', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select class_id::text as class_id from cls_report_cards')) {
        return [{ class_id: 'class-1' }];
      }
      if (sql.includes('select 1 as ok from sis_class_teachers')) {
        return []; // not assigned
      }
      return [];
    });
    const svc = new ReportCardSubjectService(fake.tenantPrisma as never);
    await expect(
      svc.create('rc-1', { subjectLabel: 'Math' }, TEACHER_ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admin bypasses teacher check', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select class_id::text as class_id from cls_report_cards')) {
        return [{ class_id: 'class-1' }];
      }
      if (sql.includes('from cls_report_card_subjects s') && sql.includes('where s.id =')) {
        return [
          {
            id: 'sub-1',
            report_card_id: 'rc-1',
            subject_label: 'Math',
            course_id: null,
            course_name: null,
            final_grade: null,
            grade_value: null,
            teacher_comments: null,
            effort_grade: null,
            sort_order: 0,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new ReportCardSubjectService(fake.tenantPrisma as never);
    const out = await svc.create('rc-1', { subjectLabel: 'Math' }, ADMIN_ACTOR);
    expect(out.subjectLabel).toBe('Math');
  });

  it('rejects subject add when parent report card does not exist', async () => {
    const fake = makeFake(() => []);
    const svc = new ReportCardSubjectService(fake.tenantPrisma as never);
    await expect(
      svc.create('rc-bogus', { subjectLabel: 'Math' }, ADMIN_ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Controller-tier permission metadata regressions
// ─────────────────────────────────────────────────────────────────────────────
describe('P2-7b controller permission metadata', () => {
  it('StandardGradeController endpoints carry the documented tch-003 gates', () => {
    const upsert = Reflect.getMetadata(PERMISSIONS_KEY, StandardGradeController.prototype.upsert);
    const listForStudent = Reflect.getMetadata(
      PERMISSIONS_KEY,
      StandardGradeController.prototype.listForStudent,
    );
    const update = Reflect.getMetadata(PERMISSIONS_KEY, StandardGradeController.prototype.update);
    const addEvidence = Reflect.getMetadata(
      PERMISSIONS_KEY,
      StandardGradeController.prototype.addEvidence,
    );
    const classReport = Reflect.getMetadata(
      PERMISSIONS_KEY,
      StandardGradeController.prototype.classReport,
    );
    expect(upsert).toEqual(['tch-003:write']);
    expect(listForStudent).toEqual(['tch-003:read']);
    expect(update).toEqual(['tch-003:write']);
    expect(addEvidence).toEqual(['tch-003:write']);
    expect(classReport).toEqual(['tch-003:read']);
  });

  it('PeerReviewController endpoints carry the documented tch-002 gates', () => {
    const enable = Reflect.getMetadata(PERMISSIONS_KEY, PeerReviewController.prototype.enable);
    const assign = Reflect.getMetadata(PERMISSIONS_KEY, PeerReviewController.prototype.assign);
    const listMy = Reflect.getMetadata(PERMISSIONS_KEY, PeerReviewController.prototype.listMy);
    const submit = Reflect.getMetadata(PERMISSIONS_KEY, PeerReviewController.prototype.submit);
    const listForSubmission = Reflect.getMetadata(
      PERMISSIONS_KEY,
      PeerReviewController.prototype.listForSubmission,
    );
    expect(enable).toEqual(['tch-002:write']);
    expect(assign).toEqual(['tch-002:write']);
    expect(listMy).toEqual(['tch-002:read']);
    expect(submit).toEqual(['tch-002:write']);
    expect(listForSubmission).toEqual(['tch-002:read']);
  });

  it('ObservationController endpoints carry the documented tch-003 gates', () => {
    const create = Reflect.getMetadata(PERMISSIONS_KEY, ObservationController.prototype.create);
    const listForStudent = Reflect.getMetadata(
      PERMISSIONS_KEY,
      ObservationController.prototype.listForStudent,
    );
    const update = Reflect.getMetadata(PERMISSIONS_KEY, ObservationController.prototype.update);
    const del = Reflect.getMetadata(PERMISSIONS_KEY, ObservationController.prototype.delete);
    expect(create).toEqual(['tch-003:write']);
    expect(listForStudent).toEqual(['tch-003:read']);
    expect(update).toEqual(['tch-003:write']);
    expect(del).toEqual(['tch-003:write']);
  });

  it('FormativeAssessmentController endpoints carry the documented tch-002 gates', () => {
    const create = Reflect.getMetadata(
      PERMISSIONS_KEY,
      FormativeAssessmentController.prototype.create,
    );
    const activate = Reflect.getMetadata(
      PERMISSIONS_KEY,
      FormativeAssessmentController.prototype.activate,
    );
    const respond = Reflect.getMetadata(
      PERMISSIONS_KEY,
      FormativeAssessmentController.prototype.respond,
    );
    const getResults = Reflect.getMetadata(
      PERMISSIONS_KEY,
      FormativeAssessmentController.prototype.getResults,
    );
    expect(create).toEqual(['tch-002:write']);
    expect(activate).toEqual(['tch-002:write']);
    expect(respond).toEqual(['tch-002:read']);
    expect(getResults).toEqual(['tch-002:read']);
  });

  it('ReportCardSubjectController endpoints carry the documented tch-003 gates', () => {
    const list = Reflect.getMetadata(
      PERMISSIONS_KEY,
      ReportCardSubjectController.prototype.listForReportCard,
    );
    const create = Reflect.getMetadata(
      PERMISSIONS_KEY,
      ReportCardSubjectController.prototype.create,
    );
    const update = Reflect.getMetadata(
      PERMISSIONS_KEY,
      ReportCardSubjectController.prototype.update,
    );
    const del = Reflect.getMetadata(PERMISSIONS_KEY, ReportCardSubjectController.prototype.delete);
    expect(list).toEqual(['tch-003:read']);
    expect(create).toEqual(['tch-003:write']);
    expect(update).toEqual(['tch-003:write']);
    expect(del).toEqual(['tch-003:write']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema invariant documentation
// ─────────────────────────────────────────────────────────────────────────────
describe('P2-7b schema invariants — documentation tests', () => {
  it('peer review submitted_chk multi-column lockstep matrix', () => {
    // ASSIGNED => submitted_at NULL
    // SUBMITTED => submitted_at NOT NULL
    // REVIEWED_BY_TEACHER => submitted_at NOT NULL
    const matrix = [
      { status: 'ASSIGNED', submittedAt: 'NULL' },
      { status: 'SUBMITTED', submittedAt: 'NOT NULL' },
      { status: 'REVIEWED_BY_TEACHER', submittedAt: 'NOT NULL' },
    ];
    expect(matrix.length).toBe(3);
  });

  it('standards proficiency_level 5-value matrix', () => {
    const levels = ['EXCEEDING', 'MEETING', 'APPROACHING', 'BELOW', 'NOT_ASSESSED'];
    expect(levels.length).toBe(5);
  });

  it('evidence_type 4-value with type-aware ref_chk', () => {
    // SUBMISSION + ASSESSMENT require evidence_ref_id NOT NULL
    // OBSERVATION + TEACHER_NOTE accept evidence_ref_id NULL
    const matrix = [
      { type: 'SUBMISSION', refRequired: true },
      { type: 'ASSESSMENT', refRequired: true },
      { type: 'OBSERVATION', refRequired: false },
      { type: 'TEACHER_NOTE', refRequired: false },
    ];
    expect(matrix.length).toBe(4);
  });

  it('observation note_type 3-value matrix', () => {
    const types = ['PROGRESS', 'CONCERN', 'COMMENDATION'];
    expect(types.length).toBe(3);
  });

  it('assessment_type 4-value matrix', () => {
    const types = ['EXIT_TICKET', 'POLL', 'QUICK_CHECK', 'DO_NOW'];
    expect(types.length).toBe(4);
  });

  it('formative active_chk multi-column lockstep matrix', () => {
    // is_active=true => activated_at NOT NULL AND closed_at NULL
    // is_active=false => any combination accepted
    const activeMatrix = { isActive: true, activatedAt: 'NOT NULL', closedAt: 'NULL' };
    expect(activeMatrix.isActive).toBe(true);
  });
});
