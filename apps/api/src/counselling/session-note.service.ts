import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { SessionService } from './session.service';
import {
  CreateSessionNoteDto,
  SessionNoteResponseDto,
  UpdateSessionNoteDto,
} from './dto/counselling.dto';

interface NoteRow {
  id: string;
  session_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  notes_text: string;
  goals_addressed: string[] | null;
  follow_up_required: boolean;
  follow_up_notes: string | null;
  is_locked: boolean;
  locked_at: string | null;
  locked_by: string | null;
  locker_first: string | null;
  locker_last: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_NOTE_BASE =
  'SELECT n.id::text AS id, n.session_id::text AS session_id, ' +
  'n.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  'n.notes_text, n.goals_addressed, n.follow_up_required, n.follow_up_notes, ' +
  'n.is_locked, ' +
  'TO_CHAR(n.locked_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS locked_at, ' +
  'n.locked_by::text AS locked_by, ' +
  'lp.first_name AS locker_first, lp.last_name AS locker_last, ' +
  'TO_CHAR(n.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(n.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_session_notes n ' +
  'JOIN sis_students s ON s.id = n.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'LEFT JOIN hr_employees le ON le.id = n.locked_by ' +
  'LEFT JOIN platform.iam_person lp ON lp.id = le.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: NoteRow): SessionNoteResponseDto {
  return {
    id: r.id,
    sessionId: r.session_id,
    studentId: r.student_id,
    studentFirstName: r.student_first,
    studentLastName: r.student_last,
    notesText: r.notes_text,
    goalsAddressed: r.goals_addressed,
    followUpRequired: r.follow_up_required,
    followUpNotes: r.follow_up_notes,
    isLocked: r.is_locked,
    lockedAt: r.locked_at,
    lockedById: r.locked_by,
    lockedByName: fullName(r.locker_first, r.locker_last),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * SessionNoteService — **FERPA KEYSTONE**.
 *
 * Every read and every write goes through `assertFerpaAccess(actor)` first.
 * That helper checks the dedicated `student_counseling_record:read`
 * permission (added to the catalogue in Cycle 11 Step 4 — the only
 * permission code that does not follow the XXX-NNN convention) plus
 * `actor.isSchoolAdmin`. The IAM seed grants this permission to Staff
 * (counsellor / VP / admin assistant) AND School Admin / Platform Admin.
 * Teachers, parents, and students NEVER hold this permission — they
 * receive a 403 with the FERPA-aware message at every endpoint.
 *
 * Note locking via `lock(id)` is **irreversible** by design. Once
 * `is_locked=true` lands the multi-column locked_chk requires
 * `locked_at` + `locked_by` to be populated together (enforced in the
 * Cycle 11 Step 2 schema). The service refuses any subsequent
 * `patch(id, ...)` with 400 "Note is locked and immutable. Create a
 * follow-up session for additional observations." There is no
 * unlockEndpoint on the controller. To correct a locked note the
 * counsellor must open a fresh session and write a new note.
 */
@Injectable()
export class SessionNoteService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * FERPA gate. Throws 403 with the canonical FERPA message if the
   * caller does not hold student_counseling_record:read at any scope
   * in the current tenant. School / Platform Admin pass via
   * `actor.isSchoolAdmin` (they hold the permission via everyFunction
   * in seed-iam.ts).
   */
  private async assertFerpaAccess(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const hasIt = await this.permissions.hasAnyPermissionInTenant(
      actor.accountId,
      tenant.schoolId,
      ['student_counseling_record:read'],
    );
    if (!hasIt) {
      throw new ForbiddenException(
        'Session notes are FERPA-protected counselling records. Teachers see caseload assignments via /counselling/caseloads. Parents see only that their child has an active caseload — they do not see session content.',
      );
    }
  }

  async listForSession(sessionId: string, actor: ResolvedActor): Promise<SessionNoteResponseDto[]> {
    await this.assertFerpaAccess(actor);
    // Enforce session row-scope before returning notes — if the caller
    // is not the counsellor of record (and not admin) they 404 even if
    // they hold the FERPA gate. This keeps notes counsellor-only inside
    // the broader Staff role.
    await this.sessions.loadOrFail(sessionId, actor);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<NoteRow[]>(
        SELECT_NOTE_BASE + 'WHERE n.session_id = $1::uuid ORDER BY n.created_at ASC',
        sessionId,
      );
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<SessionNoteResponseDto> {
    await this.assertFerpaAccess(actor);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<NoteRow[]>(SELECT_NOTE_BASE + 'WHERE n.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Session note ' + id);
    // Walk the parent session through SessionService row-scope so a
    // counsellor cannot read another counsellor's session notes by
    // guessing the note id.
    await this.sessions.loadOrFail(rows[0]!.session_id, actor);
    return rowToDto(rows[0]!);
  }

  /**
   * Create a session note. Validates the supplied student is either a
   * participant or the primary_caseload student of the session. The
   * UNIQUE(session_id, student_id) schema invariant catches duplicate
   * notes for the same (session, student) pair with a friendly 400.
   */
  async create(
    sessionId: string,
    input: CreateSessionNoteDto,
    actor: ResolvedActor,
  ): Promise<SessionNoteResponseDto> {
    await this.assertFerpaAccess(actor);
    await this.sessions.loadOrFail(sessionId, actor);
    const belongs = await this.sessions.studentBelongsToSession(sessionId, input.studentId);
    if (!belongs) {
      throw new BadRequestException(
        'studentId is not a participant of this session and does not match the primary caseload student',
      );
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO svc_session_notes ' +
            '(id, session_id, student_id, notes_text, goals_addressed, follow_up_required, follow_up_notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::text[], $6, $7)',
          id,
          sessionId,
          input.studentId,
          input.notesText,
          input.goalsAddressed ?? null,
          input.followUpRequired ?? false,
          input.followUpNotes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A session note already exists for this (session, student) pair. Edit the existing note via PATCH or open a follow-up session.',
        );
      }
      throw err;
    }
    return this.getById(id, actor);
  }

  /**
   * Update an unlocked session note. Refuses any update when
   * is_locked=true with 400. The locked_chk schema invariant doesn't
   * stop a row-level UPDATE that leaves is_locked=true — but the
   * service-side rule says locked notes are immutable, so we enforce
   * it here at the application layer before any writes.
   */
  async patch(
    id: string,
    input: UpdateSessionNoteDto,
    actor: ResolvedActor,
  ): Promise<SessionNoteResponseDto> {
    await this.assertFerpaAccess(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, session_id::text AS session_id, is_locked FROM svc_session_notes WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; session_id: string; is_locked: boolean }>;
      if (lockRows.length === 0) throw new NotFoundException('Session note ' + id);
      const note = lockRows[0]!;
      if (note.is_locked) {
        throw new BadRequestException(
          'Note is locked and immutable. Create a follow-up session for additional observations.',
        );
      }
      // Re-check session row scope inside the locked tx so a stale
      // check doesn't slip past after a session reassignment.
      await this.sessions.loadOrFail(note.session_id, actor);
      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      if (input.notesText !== undefined) {
        updates.push('notes_text = $' + idx);
        params.push(input.notesText);
        idx++;
      }
      if (input.goalsAddressed !== undefined) {
        updates.push('goals_addressed = $' + idx + '::text[]');
        params.push(input.goalsAddressed);
        idx++;
      }
      if (input.followUpRequired !== undefined) {
        updates.push('follow_up_required = $' + idx);
        params.push(input.followUpRequired);
        idx++;
      }
      if (input.followUpNotes !== undefined) {
        updates.push('follow_up_notes = $' + idx);
        params.push(input.followUpNotes);
        idx++;
      }
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      await tx.$executeRawUnsafe(
        'UPDATE svc_session_notes SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
    });
    return this.getById(id, actor);
  }

  /**
   * IRREVERSIBLE LOCK. Stamps is_locked=true + locked_at=now() +
   * locked_by=actor.employeeId in one UPDATE so the multi-column
   * locked_chk schema invariant is satisfied atomically. There is no
   * unlock endpoint — once locked the note is immutable forever, and
   * any further observations must go on a follow-up session.
   *
   * Refuses callers without an hr_employees row (Platform Admin
   * `admin@` cannot lock — clinical record per the same convention as
   * Cycle 10 medication administer).
   */
  async lock(id: string, actor: ResolvedActor): Promise<SessionNoteResponseDto> {
    await this.assertFerpaAccess(actor);
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only counsellors with an employee record can lock a session note',
      );
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, session_id::text AS session_id, is_locked FROM svc_session_notes WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; session_id: string; is_locked: boolean }>;
      if (lockRows.length === 0) throw new NotFoundException('Session note ' + id);
      const note = lockRows[0]!;
      if (note.is_locked) {
        throw new BadRequestException('Note is already locked');
      }
      await this.sessions.loadOrFail(note.session_id, actor);
      await tx.$executeRawUnsafe(
        'UPDATE svc_session_notes SET is_locked = true, locked_at = now(), locked_by = $2::uuid, ' +
          'updated_at = now() WHERE id = $1::uuid',
        id,
        actor.employeeId,
      );
    });
    return this.getById(id, actor);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.includes('23505')) return true;
  return false;
}
