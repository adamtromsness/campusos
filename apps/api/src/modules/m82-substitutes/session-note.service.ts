import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { generateId } from '@campusos/database';
import { CreateSessionNoteDto, SessionNoteResponseDto } from './dto/substitutes.dto';

interface NoteRow {
  id: string;
  assignment_id: string;
  notes_text: string;
  homework_set: string | null;
  is_visible_to_teacher: boolean;
  submitted_at: string;
}

const SELECT_NOTE_BASE = `
  SELECT n.id::text AS id,
         n.assignment_id::text AS assignment_id,
         n.notes_text,
         n.homework_set,
         n.is_visible_to_teacher,
         TO_CHAR(n.submitted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS submitted_at
  FROM sub_session_notes n
`;

/**
 * SessionNoteService — P2-9b Step 7.
 *
 * The handover note the substitute writes after CHECK_OUT. UNIQUE(assignment_id)
 * caps each assignment at one note.
 *
 * Visibility:
 *   - Admin (sub-002:write) sees all notes for own school.
 *   - Substitute who wrote it sees their own.
 *   - Returning teacher (the absent_teacher_id on the parent job) sees the
 *     note when is_visible_to_teacher = true.
 *
 * P2-9b ships the write + the row-scoped read. The TaskWorker
 * notification to the returning teacher (auto-task on
 * sub.session_note.posted) is deferred — emit the event but no consumer
 * lands a notification this cycle.
 */
@Injectable()
export class SessionNoteService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'sub-002:write',
    ]);
  }

  async getForAssignment(
    assignmentId: string,
    actor: ResolvedActor,
  ): Promise<SessionNoteResponseDto | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Get assignment + parent job's absent_teacher_id
      const rows = (await client.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.substitute_id::text AS substitute_id,
                j.absent_teacher_id::text AS absent_teacher_id
         FROM sub_assignments a
         JOIN sub_job_postings j ON j.id = a.job_id
         WHERE a.id = $1::uuid AND j.school_id = $2::uuid`,
        assignmentId,
        tenant.schoolId,
      )) as Array<{ id: string; substitute_id: string; absent_teacher_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Assignment not found');
      const asg = rows[0]!;

      const isAdmin = await this.hasAdminScope(actor);
      // Resolve substitute profile id for own-note visibility
      let subProfileId: string | null = null;
      if (actor.personId) {
        const platform = this.tenantPrisma.getPlatformClient();
        const profile = await platform.substituteProfile.findUnique({
          where: { personId: actor.personId },
        });
        subProfileId = profile?.id ?? null;
      }
      // Resolve the returning teacher (by hr_employees.id derived from actor.employeeId)
      const isReturningTeacher = actor.employeeId === asg.absent_teacher_id;

      const noteRows = (await client.$queryRawUnsafe(
        SELECT_NOTE_BASE + ' WHERE n.assignment_id = $1::uuid LIMIT 1',
        assignmentId,
      )) as NoteRow[];
      if (noteRows.length === 0) return null;
      const note = noteRows[0]!;

      if (isAdmin) return this.rowToDto(note);
      if (subProfileId && subProfileId === asg.substitute_id) return this.rowToDto(note);
      if (isReturningTeacher && note.is_visible_to_teacher) return this.rowToDto(note);

      // Visibility refused — return null (don't-leak-existence).
      return null;
    });
  }

  async create(
    assignmentId: string,
    input: CreateSessionNoteDto,
    actor: ResolvedActor,
  ): Promise<SessionNoteResponseDto> {
    const tenant = getCurrentTenant();
    const platform = this.tenantPrisma.getPlatformClient();
    const isAdmin = await this.hasAdminScope(actor);
    let subProfileId: string | null = null;
    if (actor.personId) {
      const profile = await platform.substituteProfile.findUnique({
        where: { personId: actor.personId },
      });
      subProfileId = profile?.id ?? null;
    }

    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Resolve assignment in same tx and confirm authorship
      const rows = (await tx.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.substitute_id::text AS substitute_id, a.status
         FROM sub_assignments a
         JOIN sub_job_postings j ON j.id = a.job_id
         WHERE a.id = $1::uuid AND j.school_id = $2::uuid`,
        assignmentId,
        tenant.schoolId,
      )) as Array<{ id: string; substitute_id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Assignment not found');
      const asg = rows[0]!;

      if (!isAdmin && subProfileId !== asg.substitute_id) {
        throw new ForbiddenException(
          'Only the assigned substitute (or an admin) can write the handover note.',
        );
      }

      // REVIEW-P2C9 MAJOR 5: the handover note belongs to the post-checkout
      // step in the lifecycle. Substitutes cannot write a note immediately
      // after confirmation. Admin override is allowed for unusual cases
      // (substitute forgot to write a note before leaving, etc.).
      if (!isAdmin && asg.status !== 'CHECKED_OUT') {
        throw new ConflictException(
          'Handover notes can only be written after check-out. The assignment is currently ' +
            asg.status +
            '.',
        );
      }

      try {
        await tx.$executeRawUnsafe(
          `INSERT INTO sub_session_notes (id, assignment_id, notes_text, homework_set, is_visible_to_teacher, submitted_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, now())`,
          id,
          assignmentId,
          input.notesText,
          input.homeworkSet ?? null,
          input.isVisibleToTeacher ?? true,
        );
      } catch (e) {
        const code = (e as { code?: string }).code;
        const metaCode = (e as { meta?: { code?: string } }).meta?.code;
        const msg = String(e);
        // P2002 (Prisma unique-violation) + P2010 wrapping a raw 23505
        // (Postgres) on $executeRawUnsafe + any string match against the
        // auto-generated constraint name. Past versions of this catch
        // only handled the named-constraint case, letting the raw P2010
        // / 23505 escape as a 500.
        if (
          code === 'P2002' ||
          metaCode === '23505' ||
          msg.includes('sub_session_notes_assignment_id_key') ||
          msg.includes('duplicate key value violates unique')
        ) {
          throw new ConflictException(
            'A session note already exists for this assignment. PATCH the existing row instead.',
          );
        }
        throw e;
      }

      const fresh = (await tx.$queryRawUnsafe(
        SELECT_NOTE_BASE + ' WHERE n.id = $1::uuid',
        id,
      )) as NoteRow[];
      return this.rowToDto(fresh[0]!);
    });
  }

  private rowToDto = (r: NoteRow): SessionNoteResponseDto => ({
    id: r.id,
    assignmentId: r.assignment_id,
    notesText: r.notes_text,
    homeworkSet: r.homework_set,
    isVisibleToTeacher: r.is_visible_to_teacher,
    submittedAt: r.submitted_at,
  });
}
