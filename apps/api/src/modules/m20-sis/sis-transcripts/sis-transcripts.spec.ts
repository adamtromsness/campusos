import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { LockerService } from './locker.service';
import { MedicalExemptionService } from './medical-exemption.service';
import { ReportingPeriodService } from './reporting-period.service';
import { SisTranscriptsController } from './sis-transcripts.controller';
import { StudentAwardService } from './student-award.service';
import { TranscriptService } from './transcript.service';
import { TransferService } from './transfer.service';
import { decryptCombination, encryptCombination, generateCombination } from './locker-crypto';

/**
 * P2-13c vertical slice spec.
 *
 * Coverage:
 *   S1.  TranscriptService.generate is staff/admin only.
 *   S2.  TranscriptService.generate writes frozen rows — INSERT into
 *        sis_transcript_courses, never live joins back to cls_grades.
 *   S3.  TranscriptService.submitRequest with fee creates a pay_invoice
 *        + pay_invoice_line_items in the same tenant tx as the request.
 *   S4.  TranscriptService.patchStatus refuses GENERATED -> REVOKED
 *        without revokeReason.
 *   S5.  TransferService.patch refuses INCOMING + recordsSent=true.
 *   S6.  LockerService.assign generates a fresh combination, returns
 *        plaintext once, stores only AES-256-GCM ciphertext.
 *   S7.  LockerService.bulkClear releases every ASSIGNED locker in
 *        one tx and reports the count.
 *   S8.  ReportingPeriodService.patchStatus enforces strict transitions
 *        UPCOMING -> OPEN -> GRADING_CLOSED -> PUBLISHED; refuses
 *        backwards walks + forward skips.
 *   S9.  StudentAwardService.bulkHonorRoll skips students already
 *        holding a matching HONOR_ROLL.
 *   S10. MedicalExemptionService.create rejects effective_to <
 *        effective_from.
 *   S11. encryptCombination round-trip — decryptCombination(ciphertext)
 *        recovers the plaintext.
 *   S12. encryptCombination wire format — base64(iv).base64(tag).base64(cipher).
 *   S13. generateCombination produces 3 dash-separated 2-digit segments.
 *   S14. Controller permission metadata pinned to STU-001 / 004 / 005 / 007.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e1500-0000-7556-8c81-000000000000',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e1500-0000-7556-8c81-000000000001',
  personId: '019e1500-0000-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e1500-0000-7556-8c81-000000000099',
} as never;

const TEACHER_ACTOR = {
  accountId: '019e1500-0000-7556-8c81-100000000001',
  personId: '019e1500-0000-7556-8c81-100000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: '019e1500-0000-7556-8c81-100000000099',
} as never;

const STUDENT_ID = '019e1500-0000-7556-8c81-400000000001';
const LOCKER_ID = '019e1500-0000-7556-8c81-500000000001';
const REQUEST_ID = '019e1500-0000-7556-8c81-600000000001';
const PERIOD_ID = '019e1500-0000-7556-8c81-700000000001';
const FAMILY_ACCOUNT_ID = '019e1500-0000-7556-8c81-800000000001';

interface CapturedCall {
  sql: string;
  args: unknown[];
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

function makePerms(grant = true) {
  return { hasAnyPermissionInTenant: async () => grant };
}

/**
 * REVIEW-P2C13 outbox stub — captures every enqueueInTx so tests can
 * assert durable emits land with the deterministic event_id.
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

describe('SIS Transcripts + Transfers + Lockers — P2-13c', () => {
  // ─── S1 ───
  it('S1: TranscriptService.generate refuses non-staff non-admin', async () => {
    const fake = makeFake();
    const { outbox } = makeOutbox();
    const svc = new TranscriptService(
      fake.tenantPrisma as never,
      makePerms(false) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.generate(
          STUDENT_ID,
          { transcriptType: 'OFFICIAL' } as never,
          { ...TEACHER_ACTOR, isSchoolAdmin: false } as never,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── S2 ───
  it('S2: TranscriptService.generate snapshots cls_grades + writes frozen course rows', async () => {
    let gradesQueried = 0;
    let courseInserts = 0;
    let transcriptInserts = 0;
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from sis_students') && sql.includes('school_id')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from sis_gpa_configurations') && sql.includes('is_default')) {
        return [{ id: '019e1500-0000-7556-8c81-900000000001' }];
      }
      if (sql.includes('from sis_gpa_configurations')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from sis_student_gpa_snapshots')) {
        return [
          { cumulative_gpa: '3.875', total_credits_earned: '22.0', class_rank: 5, class_size: 120 },
        ];
      }
      if (sql.includes('from cls_grades')) {
        gradesQueried += 1;
        return [
          {
            class_id: '019e1500-0000-7556-8c81-aaaaaaaaaaa1',
            academic_year: '2025-2026',
            term: 'Fall',
            course_name: 'Algebra II',
            course_code: 'MATH-202',
            credits: '1.0',
            grade: 'A',
            grade_points: '4.0',
            is_honors: false,
            is_ap: false,
          },
        ];
      }
      if (sql.includes('insert into sis_transcripts')) {
        transcriptInserts += 1;
        return 1;
      }
      if (sql.includes('insert into sis_transcript_courses')) {
        courseInserts += 1;
        return 1;
      }
      if (sql.includes('from sis_transcripts t')) {
        // Final reload — return a single transcript row.
        return [
          {
            id: '019e1500-0000-7556-8c81-cccccccccc01',
            student_id: STUDENT_ID,
            student_first_name: 'Maya',
            student_last_name: 'Chen',
            transcript_type: 'OFFICIAL',
            generated_at: '2026-05-11T00:00:00+00:00',
            generated_by: ADMIN_ACTOR.personId,
            generated_by_first_name: 'Sarah',
            generated_by_last_name: 'Mitchell',
            gpa_config_id: '019e1500-0000-7556-8c81-900000000001',
            cumulative_gpa_snapshot: '3.875',
            total_credits: '1.00',
            class_rank: 5,
            class_size: 120,
            pdf_s3_key: null,
            recipient_name: null,
            recipient_address: null,
            recipient_email: null,
            linked_request_id: null,
            status: 'GENERATED',
            sent_at: null,
            revoked_at: null,
            revoke_reason: null,
          },
        ];
      }
      if (sql.includes('from sis_transcript_courses')) {
        return [
          {
            id: '019e1500-0000-7556-8c81-dddddddddd01',
            academic_year: '2025-2026',
            term: 'Fall',
            course_name: 'Algebra II',
            course_code: 'MATH-202',
            credits: '1.0',
            grade: 'A',
            grade_points: '4.0',
            is_honors: false,
            is_ap: false,
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new TranscriptService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      const out = await svc.generate(
        STUDENT_ID,
        { transcriptType: 'OFFICIAL' } as never,
        ADMIN_ACTOR,
      );
      expect(transcriptInserts).toBe(1);
      expect(courseInserts).toBe(1);
      expect(gradesQueried).toBe(1);
      expect(out.transcriptType).toBe('OFFICIAL');
      expect(out.courses).toHaveLength(1);
      expect(out.courses[0]!.courseName).toBe('Algebra II');
    });
  });

  // ─── S3 — REVIEW-P2C13 BLOCKING 7 ───
  it('S3: TranscriptService.submitRequest with fee emits sis.transcript_request.fee_requested via outbox + writes ZERO pay_* rows', async () => {
    let invoiceInserts = 0;
    let lineItemInserts = 0;
    let requestInserts = 0;
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from sis_students') && sql.includes('school_id')) return [{ ok: 1 }];
      if (sql.includes('from pay_family_accounts')) return [{ status: 'ACTIVE' }];
      if (sql.includes('insert into pay_invoices')) {
        invoiceInserts += 1;
        return 1;
      }
      if (sql.includes('insert into pay_invoice_line_items')) {
        lineItemInserts += 1;
        return 1;
      }
      if (sql.includes('insert into sis_transcript_requests')) {
        requestInserts += 1;
        return 1;
      }
      if (sql.includes('from sis_transcript_requests r')) {
        return [
          {
            id: REQUEST_ID,
            student_id: STUDENT_ID,
            student_first_name: 'Maya',
            student_last_name: 'Chen',
            requested_by: ADMIN_ACTOR.personId,
            requested_by_first_name: 'Sarah',
            requested_by_last_name: 'Mitchell',
            recipient_name: 'Stanford',
            recipient_address: null,
            recipient_email: null,
            transcript_type: 'OFFICIAL',
            copies: 2,
            fee_amount: '10.00',
            fee_paid: false,
            linked_invoice_id: null,
            status: 'SUBMITTED',
            notes: null,
            processed_at: null,
            sent_at: null,
            picked_up_at: null,
            cancelled_at: null,
            cancel_reason: null,
            created_at: '2026-05-11T00:00:00+00:00',
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new TranscriptService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      const out = await svc.submitRequest(
        {
          studentId: STUDENT_ID,
          recipientName: 'Stanford',
          transcriptType: 'OFFICIAL',
          copies: 2,
          feeAmount: 10.0,
          familyAccountId: FAMILY_ACCOUNT_ID,
        } as never,
        ADMIN_ACTOR,
      );
      // SIS no longer writes Payment-module tables directly.
      expect(invoiceInserts).toBe(0);
      expect(lineItemInserts).toBe(0);
      expect(requestInserts).toBe(1);
      // Outbox emit fires inside the same tx with deterministic id +
      // full fee context for the Payments consumer.
      expect(enqueued.length).toBe(1);
      expect(enqueued[0]!.topic).toBe('sis.transcript_request.fee_requested');
      expect(enqueued[0]!.sourceModule).toBe('sis-transcripts');
      expect(enqueued[0]!.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const payload = enqueued[0]!.payload as {
        requestId: string;
        familyAccountId: string;
        feeAmount: number;
        copies: number;
        lineTotal: number;
      };
      // requestId is generated at runtime; assert shape + non-empty.
      expect(payload.requestId).toMatch(/^[0-9a-f]{8}-/);
      expect(payload.familyAccountId).toBe(FAMILY_ACCOUNT_ID);
      expect(payload.feeAmount).toBe(10);
      expect(payload.copies).toBe(2);
      expect(payload.lineTotal).toBe(20);
      // linked_invoice_id starts NULL — the Payments consumer back-fills.
      expect(out.linkedInvoiceId).toBeNull();
    });
  });

  // ─── S4 ───
  it('S4: TranscriptService.patchStatus rejects REVOKED without revokeReason', async () => {
    const fake = makeFake();
    const { outbox } = makeOutbox();
    const svc = new TranscriptService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.patchStatus(
          '019e1500-0000-7556-8c81-cccccccccc01',
          { status: 'REVOKED' } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S5 ───
  it('S5: TransferService.patch refuses INCOMING + recordsSent=true', async () => {
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from sis_transfer_records')) {
        return [{ transfer_direction: 'INCOMING', records_received: true, records_sent: false }];
      }
      return [];
    });
    const svc = new TransferService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.patch(
          '019e1500-0000-7556-8c81-ffffffffff01',
          { recordsSent: true } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S6 ───
  it('S6: LockerService.assign encrypts combination at rest, returns plaintext once', async () => {
    let updateCount = 0;
    let combinationCiphertext: string | null = null;
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from sis_students') && sql.includes('school_id')) return [{ ok: 1 }];
      if (sql.includes('select status from sis_lockers') && sql.includes('school_id')) {
        return [{ status: 'AVAILABLE' }];
      }
      if (sql.includes('update sis_lockers') && sql.includes("'assigned'")) {
        updateCount += 1;
        const args = call.args;
        if (typeof args[2] === 'string') {
          combinationCiphertext = args[2];
        }
        return 1;
      }
      if (sql.includes('from sis_lockers l') && sql.includes('where l.id =')) {
        return [
          {
            id: LOCKER_ID,
            locker_number: 'A-101',
            location_description: 'Hallway A',
            combination_encrypted: combinationCiphertext,
            status: 'ASSIGNED',
            assigned_to_student_id: STUDENT_ID,
            assigned_to_student_first_name: 'Maya',
            assigned_to_student_last_name: 'Chen',
            assigned_at: '2026-05-11',
            academic_year: '2025-2026',
            notes: null,
          },
        ];
      }
      return [];
    });
    const svc = new LockerService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      const out = await svc.assign(
        {
          lockerId: LOCKER_ID,
          studentId: STUDENT_ID,
          academicYear: '2025-2026',
          combination: '11-22-33',
        } as never,
        ADMIN_ACTOR,
      );
      expect(updateCount).toBe(1);
      expect(out.combination).toBe('11-22-33');
      expect(out.locker.hasCombination).toBe(true);
      expect(combinationCiphertext).not.toBeNull();
      // Verify the wire format — three base64 segments.
      const parts = (combinationCiphertext ?? '').split('.');
      expect(parts).toHaveLength(3);
      // Plaintext must not appear in the ciphertext column.
      expect(combinationCiphertext).not.toContain('11-22-33');
      // Decrypt round-trips back to the original.
      expect(decryptCombination(combinationCiphertext)).toBe('11-22-33');
    });
  });

  // ─── S7 ───
  it('S7: LockerService.bulkClear releases every ASSIGNED locker in one tx', async () => {
    let lockedCount = 0;
    let updateCalls = 0;
    const matches = [
      { id: 'l1' },
      { id: 'l2' },
      { id: 'l3' },
      { id: 'l4' },
      { id: 'l5' },
      { id: 'l6' },
    ];
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('select id::text as id from sis_lockers')) {
        lockedCount = matches.length;
        return matches;
      }
      if (sql.includes("update sis_lockers set status = 'available'")) {
        updateCalls += 1;
        return matches.length;
      }
      return [];
    });
    const svc = new LockerService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      const out = await svc.bulkClear({} as never, ADMIN_ACTOR);
      expect(updateCalls).toBe(1);
      expect(out.cleared).toBe(6);
      expect(lockedCount).toBe(6);
    });
  });

  // ─── S8 ───
  it('S8: ReportingPeriodService.patchStatus enforces UPCOMING -> OPEN forward only', async () => {
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('select status, school_id::text')) {
        return [{ status: 'OPEN', school_id: SCHOOL.schoolId }];
      }
      return [];
    });
    const svc = new ReportingPeriodService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      // OPEN -> UPCOMING (backward) refused.
      await expect(
        svc.patchStatus(PERIOD_ID, { status: 'UPCOMING' } as never, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      // OPEN -> PUBLISHED (skip GRADING_CLOSED) refused.
      await expect(
        svc.patchStatus(PERIOD_ID, { status: 'PUBLISHED' } as never, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S9 ───
  it('S9: StudentAwardService.bulkHonorRoll skips students already holding the matching award', async () => {
    let awardInserts = 0;
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from sis_student_gpa_snapshots')) {
        return [{ student_id: 'student-a' }, { student_id: 'student-b' }];
      }
      if (sql.includes('from sis_student_awards') && sql.includes('honor_roll')) {
        // student-a already has the award; student-b does not.
        if ((call.args[0] as string) === 'student-a') return [{ ok: 1 }];
        return [];
      }
      if (sql.includes('insert into sis_student_awards')) {
        awardInserts += 1;
        return 1;
      }
      return [];
    });
    const svc = new StudentAwardService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      const out = await svc.bulkHonorRoll(
        {
          academicYear: '2025-2026',
          term: 'Q1',
          gpaThreshold: 3.5,
        } as never,
        ADMIN_ACTOR,
      );
      expect(out.awarded).toBe(1);
      expect(out.skipped).toBe(1);
      expect(awardInserts).toBe(1);
    });
  });

  // ─── S10 ───
  it('S10: MedicalExemptionService.create rejects effective_to < effective_from', async () => {
    const fake = makeFake();
    const svc = new MedicalExemptionService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.create(
          {
            studentId: STUDENT_ID,
            exemptionType: 'PE',
            reason: 'broken arm',
            effectiveFrom: '2026-06-01',
            effectiveTo: '2026-05-01',
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S11 ───
  it('S11: encryptCombination round-trips through decryptCombination', () => {
    const plaintext = '07-14-21';
    const wire = encryptCombination(plaintext);
    expect(decryptCombination(wire)).toBe(plaintext);
  });

  // ─── S12 ───
  it('S12: encryptCombination wire format — base64(iv).base64(tag).base64(cipher)', () => {
    const wire = encryptCombination('33-44-55');
    const parts = wire.split('.');
    expect(parts).toHaveLength(3);
    // iv is 12 bytes = 16 base64 chars; tag is 16 bytes = 24 base64 chars.
    expect(parts[0]!.length).toBeGreaterThanOrEqual(16);
    expect(parts[1]!.length).toBeGreaterThanOrEqual(20);
    // Plaintext must not appear anywhere in the wire form.
    expect(wire).not.toContain('33-44-55');
  });

  // ─── S13 ───
  it('S13: generateCombination produces 3 dash-separated 2-digit segments', () => {
    for (let i = 0; i < 10; i += 1) {
      const combo = generateCombination();
      expect(combo).toMatch(/^\d{2}-\d{2}-\d{2}$/);
    }
  });

  // ─── S14 ───
  it('S14: SisTranscriptsController routes carry STU-001 / 004 / 005 / 007 permission metadata', () => {
    const controller = SisTranscriptsController.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    function readPermissions(method: string): string[] {
      const codes = Reflect.getMetadata(PERMISSIONS_KEY, controller[method]!);
      return (codes ?? []) as string[];
    }
    expect(readPermissions('listTranscripts')).toEqual(['stu-005:read']);
    expect(readPermissions('generateTranscript')).toEqual(['stu-005:write']);
    expect(readPermissions('listTransfers')).toEqual(['stu-004:read']);
    expect(readPermissions('createTransfer')).toEqual(['stu-004:write']);
    expect(readPermissions('listLockers')).toEqual(['stu-007:read']);
    expect(readPermissions('assignLocker')).toEqual(['stu-007:write']);
    expect(readPermissions('bulkClearLockers')).toEqual(['stu-007:admin']);
    expect(readPermissions('listReportingPeriods')).toEqual(['stu-005:read']);
    expect(readPermissions('createReportingPeriod')).toEqual(['stu-005:admin']);
    expect(readPermissions('bulkHonorRoll')).toEqual(['stu-005:write']);
    expect(readPermissions('listStudentExemptions')).toEqual(['stu-001:read']);
    expect(readPermissions('createExemption')).toEqual(['stu-001:write']);
  });

  // ─── Negative path: NotFound passes through ───
  it('LockerService.release rejects when locker is not ASSIGNED', async () => {
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      // REVIEW-P2C13 MAJOR 2 — lock now binds school predicate into
      // SELECT FOR UPDATE so the matcher must include school_id.
      if (sql.includes('select status from sis_lockers') && sql.includes('school_id')) {
        return [{ status: 'AVAILABLE' }];
      }
      return [];
    });
    const svc = new LockerService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(svc.release(LOCKER_ID, ADMIN_ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('LockerService.release rejects on missing locker', async () => {
    const fake = makeFake();
    const svc = new LockerService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(svc.release(LOCKER_ID, ADMIN_ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── REVIEW-P2C13 REGRESSION TESTS ───

  /**
   * R-B6: transcript reads carry s.school_id = $tenant.schoolId on
   * every code path. Test verifies the SQL string actually contains
   * the school predicate.
   */
  it('R-B6: transcript reads bind sis_students.school_id', async () => {
    const fake = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new TranscriptService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.getById('019e1500-0000-7556-8c81-cccccccccc01', ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    // The transcripts SELECT must JOIN sis_students with the school
    // predicate baked in.
    const transcriptSelect = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('from sis_transcripts t') &&
        c.sql.toLowerCase().includes('join sis_students s') &&
        c.sql.toLowerCase().includes('s.school_id = $2::uuid'),
    );
    expect(transcriptSelect).toBeDefined();
  });

  /**
   * R-B8: transfer reads + locks bind sis_students.school_id.
   */
  it('R-B8: transfer reads + locks bind sis_students.school_id', async () => {
    const fake = makeFake(() => []);
    const svc = new TransferService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.getById('019e1500-0000-7556-8c81-ffffffffff99', ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    const transferSelect = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('from sis_transfer_records t') &&
        c.sql.toLowerCase().includes('join sis_students s') &&
        c.sql.toLowerCase().includes('s.school_id = $2::uuid'),
    );
    expect(transferSelect).toBeDefined();
  });

  /**
   * R-B6b: transcript request transitions lock through sis_students
   * with the school predicate.
   */
  it('R-B6b: transcript request status transition lock binds school predicate', async () => {
    const fake = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new TranscriptService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.patchRequestStatus(REQUEST_ID, { status: 'PROCESSING' } as never, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    const lockSql = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('from sis_transcript_requests r') &&
        c.sql.toLowerCase().includes('join sis_students s') &&
        c.sql.toLowerCase().includes('for update of r'),
    );
    expect(lockSql).toBeDefined();
  });

  /**
   * R-B6c: transcript status PATCH lock binds school predicate.
   */
  it('R-B6c: transcript status PATCH lock binds school predicate', async () => {
    const fake = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new TranscriptService(
      fake.tenantPrisma as never,
      makePerms() as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.patchStatus(
          '019e1500-0000-7556-8c81-cccccccccc01',
          { status: 'SENT' } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    const lockSql = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('from sis_transcripts t') &&
        c.sql.toLowerCase().includes('join sis_students s') &&
        c.sql.toLowerCase().includes('for update of t'),
    );
    expect(lockSql).toBeDefined();
  });

  /**
   * R-M2: locker assign lock binds school predicate via FOR UPDATE
   * with school_id baked into the WHERE clause.
   */
  it('R-M2: locker assign lock binds school predicate into SELECT FOR UPDATE', async () => {
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from sis_students') && sql.includes('school_id')) return [{ ok: 1 }];
      return [];
    });
    const svc = new LockerService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.assign(
          {
            lockerId: LOCKER_ID,
            studentId: STUDENT_ID,
            academicYear: '2025-2026',
            combination: '11-22-33',
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    const lockSql = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('select status from sis_lockers') &&
        c.sql.toLowerCase().includes('id = $1::uuid') &&
        c.sql.toLowerCase().includes('school_id = $2::uuid') &&
        c.sql.toLowerCase().includes('for update'),
    );
    expect(lockSql).toBeDefined();
  });

  /**
   * R-M1: medical exemption reads bind sis_students.school_id.
   */
  it('R-M1: medical exemption list binds sis_students.school_id', async () => {
    const fake = makeFake(() => []);
    const svc = new MedicalExemptionService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await svc.listForStudent(STUDENT_ID, ADMIN_ACTOR);
    });
    const listSql = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('from sis_medical_exemption_records e') &&
        c.sql.toLowerCase().includes('join sis_students s') &&
        c.sql.toLowerCase().includes('s.school_id = $2::uuid'),
    );
    expect(listSql).toBeDefined();
  });
});
