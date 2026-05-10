import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { CreateOptOutDto, OptOutResponseDto } from './dto/ai-tutoring.dto';

interface OptOutRow {
  id: string;
  student_id: string;
  student_name: string | null;
  opted_out_by: string;
  opted_out_by_name: string | null;
  opted_out_at: Date | string;
  reason: string | null;
}

function toIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(row: OptOutRow): OptOutResponseDto {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    optedOutBy: row.opted_out_by,
    optedOutByName: row.opted_out_by_name,
    optedOutAt: toIso(row.opted_out_at),
    reason: row.reason,
  };
}

const SELECT_OPT_OUT_BASE =
  'SELECT o.id, o.student_id::text AS student_id, ' +
  "(ip_s.first_name || ' ' || ip_s.last_name) AS student_name, " +
  'o.opted_out_by::text AS opted_out_by, ' +
  "(ip_o.first_name || ' ' || ip_o.last_name) AS opted_out_by_name, " +
  'o.opted_out_at, o.reason ' +
  'FROM cls_ai_tutoring_opt_outs o ' +
  'LEFT JOIN sis_students st ON st.id = o.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = st.platform_student_id ' +
  'LEFT JOIN platform.iam_person ip_s ON ip_s.id = ps.person_id ' +
  'LEFT JOIN platform.iam_person ip_o ON ip_o.id = o.opted_out_by ';

/**
 * AIOptOutService — P2-7c Step 6.
 *
 * AI tutoring opt-out is hard-gated per ADR-004. The cls_ai_tutoring_opt_outs
 * table carries UNIQUE(student_id) so each student has at most one row. The
 * AITutoringService.assertNotOptedOut helper reads this table before every
 * session start and every message — even school admin override is rejected
 * because opt-out is a parental / student right.
 *
 * Authorisation:
 *   - GUARDIAN may opt out their own children only (sis_student_guardians
 *     row required).
 *   - STUDENT may opt out themselves (subject to age verification — the
 *     schema accepts any student_id, the policy gate is the COPPA / FERPA
 *     age-13 rule which is enforced at the controller layer in production).
 *   - SCHOOL_ADMIN may opt out any student in the school (e.g. for
 *     emergency revocation when a parent calls in).
 */
@Injectable()
export class AIOptOutService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Read-only check used by AITutoringService.assertNotOptedOut. Returns
   * true when an opt-out row exists for the student.
   */
  async isOptedOut(studentId: string): Promise<boolean> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM cls_ai_tutoring_opt_outs WHERE student_id = $1::uuid LIMIT 1',
        studentId,
      );
    });
    return rows.length > 0;
  }

  /** POST /classroom/ai-tutoring/opt-out — opt a student out. */
  async create(input: CreateOptOutDto, actor: ResolvedActor): Promise<OptOutResponseDto> {
    await this.assertCanOptOut(input.studentId, actor);
    // Check existing
    const existing = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM cls_ai_tutoring_opt_outs WHERE student_id = $1::uuid',
        input.studentId,
      );
    });
    if (existing.length > 0) {
      throw new BadRequestException(
        'Student is already opted out. Patch the existing record or DELETE first to opt back in.',
      );
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO cls_ai_tutoring_opt_outs (id, student_id, opted_out_by, reason) VALUES ' +
          '($1::uuid, $2::uuid, $3::uuid, $4)',
        id,
        input.studentId,
        actor.personId,
        input.reason ?? null,
      );
    });
    return this.getByStudent(input.studentId, actor);
  }

  /** GET /classroom/ai-tutoring/opt-out/:studentId — check status. */
  async getByStudent(studentId: string, actor: ResolvedActor): Promise<OptOutResponseDto> {
    await this.assertCanReadOptOut(studentId, actor);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<OptOutRow[]>(
        SELECT_OPT_OUT_BASE + ' WHERE o.student_id = $1::uuid',
        studentId,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException('No opt-out record found for student ' + studentId);
    }
    return rowToDto(rows[0]!);
  }

  /** DELETE /classroom/ai-tutoring/opt-out/:studentId — opt back in. */
  async delete(studentId: string, actor: ResolvedActor): Promise<void> {
    await this.assertCanOptOut(studentId, actor);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM cls_ai_tutoring_opt_outs WHERE student_id = $1::uuid',
        studentId,
      );
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async assertCanOptOut(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'GUARDIAN') {
      // Verify guardian linkage to the student
      const linked = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        );
      });
      if (linked.length === 0) {
        throw new ForbiddenException(
          'Guardians may only opt out their own linked children. No relationship found.',
        );
      }
      return;
    }
    if (actor.personType === 'STUDENT') {
      const own = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT s.id::text AS id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE ps.person_id = $1::uuid',
          actor.personId,
        );
      });
      if (own.length === 0 || own[0]!.id !== studentId) {
        throw new ForbiddenException('Students may only opt themselves out.');
      }
      return;
    }
    throw new ForbiddenException(
      'Only the student, a linked guardian, or a school admin may opt a student out of AI tutoring.',
    );
  }

  private async assertCanReadOptOut(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin || actor.personType === 'STAFF') return;
    // Otherwise reuse the write-side scope check
    await this.assertCanOptOut(studentId, actor);
  }
}
