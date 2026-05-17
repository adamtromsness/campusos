import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  STUDENT_NOTE_TYPES,
  type CreateStudentNoteDto,
  type StudentNoteDto,
  type StudentNoteType,
} from '../students/dto/sis-advanced.dto';

interface NoteRow {
  id: string;
  student_id: string;
  author_id: string;
  author_first_name: string | null;
  author_last_name: string | null;
  note_type: string;
  note_text: string;
  is_parent_visible: boolean;
  is_confidential: boolean;
  created_at: string;
}

/**
 * Staff-authored student notes.
 *
 * Visibility model:
 *   - Admin → all rows (including CONFIDENTIAL authored by anyone).
 *   - STAFF author (actor.personId === author_id) → own notes
 *     including own CONFIDENTIAL.
 *   - STAFF non-author → all rows EXCLUDING is_confidential=true.
 *   - GUARDIAN → is_parent_visible=true AND is_confidential=false
 *     (the confidential_chk schema invariant already rules out the
 *     contradictory case; we keep both predicates for defence in
 *     depth).
 *   - STUDENT / other → no rows.
 *
 * Writes (POST):
 *   - STAFF + admin only via stu-002:write at the controller. CONFIDENTIAL
 *     notes refuse is_parent_visible=true at write time so the impossible
 *     combination never lands.
 */
@Injectable()
export class StudentNoteService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private rowToDto(r: NoteRow): StudentNoteDto {
    return {
      id: r.id,
      studentId: r.student_id,
      authorId: r.author_id,
      authorName:
        r.author_first_name && r.author_last_name
          ? r.author_first_name + ' ' + r.author_last_name
          : null,
      noteType: r.note_type as StudentNoteType,
      noteText: r.note_text,
      isVisibleToParent: r.is_parent_visible,
      isConfidential: r.is_confidential,
      createdAt: r.created_at,
    };
  }

  private async isStaff(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-002:write',
      'stu-002:admin',
    ]);
  }

  /**
   * P2-H5 DEFECT 1a fix: school-scope the student existence check so a
   * crafted cross-school studentId cannot pass and then be used to read
   * parent-visible notes or attach notes to a foreign student. Optional
   * `client` parameter lets `create` re-run the same check inside the
   * tenant transaction that performs the INSERT.
   */
  private async assertStudentExists(
    studentId: string,
    client?: { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> },
  ): Promise<void> {
    const tenant = getCurrentTenant();
    const exec = async (c: {
      $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
    }) =>
      c.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      );
    const rows = client
      ? await exec(client)
      : await this.tenantPrisma.executeInTenantContext(async (c) => exec(c));
    if (rows.length === 0) throw new NotFoundException('Student ' + studentId + ' not found');
  }

  /**
   * Build the visibility SQL fragment + bound params (after the studentId
   * placeholder which is $1).
   */
  private buildVisibilityFragment(
    actor: ResolvedActor,
    startParam: number,
  ): { fragment: string; params: unknown[] } {
    if (actor.isSchoolAdmin) {
      return { fragment: '', params: [] };
    }
    if (actor.personType === 'STAFF') {
      // Non-confidential rows OR own confidential rows.
      return {
        fragment: ' AND (is_confidential = false OR author_id = $' + startParam + '::uuid)',
        params: [actor.personId],
      };
    }
    if (actor.personType === 'GUARDIAN') {
      // Only parent-visible, non-confidential rows for own children.
      return {
        fragment:
          ' AND is_parent_visible = true AND is_confidential = false AND student_id IN ' +
          '(SELECT sg.student_id FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE g.person_id = $' +
          startParam +
          '::uuid)',
        params: [actor.personId],
      };
    }
    // STUDENT / other personas have no access.
    return { fragment: ' AND FALSE', params: [] };
  }

  async listForStudent(studentId: string, actor: ResolvedActor): Promise<StudentNoteDto[]> {
    await this.assertStudentExists(studentId);
    // P2-H5 DEFECT 1a fix: every read binds n.school_id = currentTenant.schoolId
    // so a crafted cross-school studentId returns an empty list rather than
    // surfacing foreign-school rows the visibility fragment might otherwise let
    // through (e.g. parent-visible notes from another school).
    const tenant = getCurrentTenant();
    const visibility = this.buildVisibilityFragment(actor, 3);
    const params: unknown[] = [studentId, tenant.schoolId, ...visibility.params];
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<NoteRow[]>(
        'SELECT n.id::text, n.student_id::text, n.author_id::text, ' +
          'ip.first_name AS author_first_name, ip.last_name AS author_last_name, ' +
          'n.note_type, n.note_text, n.is_parent_visible, n.is_confidential, ' +
          'n.created_at::text ' +
          'FROM sis_student_notes n ' +
          'LEFT JOIN platform.iam_person ip ON ip.id = n.author_id ' +
          'WHERE n.student_id = $1::uuid AND n.school_id = $2::uuid' +
          visibility.fragment +
          ' ORDER BY n.created_at DESC',
        ...params,
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async createForStudent(
    studentId: string,
    dto: CreateStudentNoteDto,
    actor: ResolvedActor,
  ): Promise<StudentNoteDto> {
    if (!(await this.isStaff(actor))) {
      throw new ForbiddenException('Only staff or admins can author student notes.');
    }
    if (!STUDENT_NOTE_TYPES.includes(dto.noteType)) {
      throw new BadRequestException('noteType must be one of ' + STUDENT_NOTE_TYPES.join(', '));
    }
    if (dto.isConfidential === true && dto.isVisibleToParent === true) {
      throw new BadRequestException(
        'A note cannot be both CONFIDENTIAL and visible to the parent — the confidential_chk schema invariant prevents this.',
      );
    }

    const tenant = getCurrentTenant();
    const id = generateId();
    const isConfidential = dto.isConfidential === true || dto.noteType === 'CONFIDENTIAL';
    const isParentVisible = !isConfidential && dto.isVisibleToParent === true;

    // P2-H5 DEFECT 1a fix: validate the target student inside the SAME tenant
    // transaction as the INSERT. A pre-tx existence check could pass against a
    // crafted cross-school studentId between check and write, or the student
    // could be re-keyed before commit.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await this.assertStudentExists(studentId, tx);
      await tx.$executeRawUnsafe(
        'INSERT INTO sis_student_notes (id, school_id, student_id, author_id, note_type, ' +
          'note_text, is_parent_visible, is_confidential) VALUES ' +
          '($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8)',
        id,
        tenant.schoolId,
        studentId,
        actor.personId,
        dto.noteType,
        dto.noteText,
        isParentVisible,
        isConfidential,
      );
    });

    // P2-H1 Step 1: post-insert reload joins through school_id so the DTO
    // cannot surface a foreign-school row even on a stale loader path. The
    // `tenant` const is already in scope from the insert preamble above.
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<NoteRow[]>(
        'SELECT n.id::text, n.student_id::text, n.author_id::text, ' +
          'ip.first_name AS author_first_name, ip.last_name AS author_last_name, ' +
          'n.note_type, n.note_text, n.is_parent_visible, n.is_confidential, ' +
          'n.created_at::text ' +
          'FROM sis_student_notes n ' +
          'LEFT JOIN platform.iam_person ip ON ip.id = n.author_id ' +
          'WHERE n.id = $1::uuid AND n.school_id = $2::uuid',
        id,
        tenant.schoolId,
      ),
    );
    return this.rowToDto(rows[0]!);
  }

  async delete(id: string, actor: ResolvedActor): Promise<void> {
    // P2-H1 Step 1: school-scope both the authz pre-check and the DELETE.
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ author_id: string; is_confidential: boolean }>>(
        'SELECT author_id::text AS author_id, is_confidential FROM sis_student_notes ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Note not found');
    if (!actor.isSchoolAdmin && rows[0]!.author_id !== actor.personId) {
      throw new ForbiddenException('Only the note author or an admin can delete this note.');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'DELETE FROM sis_student_notes WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      ),
    );
  }
}
