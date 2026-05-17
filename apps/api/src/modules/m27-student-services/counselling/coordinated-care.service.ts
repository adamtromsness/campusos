import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  CareAuthorRole,
  CoordinatedCareNoteDto,
  CreateCoordinatedCareNoteDto,
} from './dto/counselling.dto';

interface CareNoteRow {
  id: string;
  student_id: string;
  author_person_id: string;
  author_first: string | null;
  author_last: string | null;
  author_role: string;
  note_text: string;
  created_at: string;
}

const SELECT_NOTE_BASE =
  'SELECT n.id::text AS id, n.student_id::text AS student_id, ' +
  'n.author_person_id::text AS author_person_id, ' +
  'p.first_name AS author_first, p.last_name AS author_last, ' +
  'n.author_role, n.note_text, ' +
  'TO_CHAR(n.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM svc_coordinated_care_notes n ' +
  'LEFT JOIN platform.iam_person p ON p.id = n.author_person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: CareNoteRow): CoordinatedCareNoteDto {
  return {
    id: r.id,
    studentId: r.student_id,
    authorPersonId: r.author_person_id,
    authorName: fullName(r.author_first, r.author_last),
    authorRole: r.author_role as CareAuthorRole,
    noteText: r.note_text,
    createdAt: r.created_at,
  };
}

/**
 * CoordinatedCareService — INTERSECTION GATE.
 *
 * The coordinated care thread is shared between the nurse and
 * counsellor teams ONLY. Every endpoint requires the **intersection**
 * of `hlt-001:read` AND `cou-007:read` — neither permission alone
 * unlocks the surface. The IAM seed grants both codes to Staff
 * (counsellor / VP / nurse — all the personnel the seed groups under
 * the Staff role) plus all 3 admin-tier holders (School Admin,
 * Platform Admin) via the `everyFunction` grant. Teachers hold
 * `hlt-001:read` (for the per-student health alert summary) but NOT
 * `cou-007:read`. Parents hold `hlt-001:read` (for own-child summary)
 * but NOT `cou-007:read`. Students hold neither. The result is the
 * surface is locked to the union of the nurse AND counsellor teams as
 * the M27 ERD requires.
 *
 * `assertIntersectionAccess(actor)` calls
 * `permissionCheckService.hasAnyPermissionInTenant` twice — once for
 * each code — and 403s if either is missing. Admins still pass via
 * `actor.isSchoolAdmin` short-circuit (they hold the intersection
 * through the everyFunction grant).
 */
@Injectable()
export class CoordinatedCareService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async assertIntersectionAccess(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const [hasHealth, hasCare] = await Promise.all([
      this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, ['hlt-001:read']),
      this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, ['cou-007:read']),
    ]);
    if (!hasHealth || !hasCare) {
      throw new ForbiddenException(
        'Coordinated care notes are shared between the health and counselling teams only — both hlt-001:read AND cou-007:read are required.',
      );
    }
  }

  async listForStudent(studentId: string, actor: ResolvedActor): Promise<CoordinatedCareNoteDto[]> {
    await this.assertIntersectionAccess(actor);
    // Validate student exists in tenant.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        studentId,
      )) as Array<{ ok: number }>;
      if (r.length === 0) throw new NotFoundException('Student ' + studentId);
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CareNoteRow[]>(
        SELECT_NOTE_BASE + 'WHERE n.student_id = $1::uuid ORDER BY n.created_at DESC',
        studentId,
      );
    });
    return rows.map(rowToDto);
  }

  /**
   * Create a coordinated care note. The author_role on the payload is
   * validated against the actor's actual team membership — a NURSE
   * note must come from a caller who holds nurse scope (hlt-001:write),
   * and a COUNSELLOR note must come from a caller who holds counsellor
   * scope (cou-001:write or cou-007:write). Admins are exempted from
   * the role-vs-perm check (they hold everything via everyFunction).
   * Stamps `author_person_id` from `actor.personId` so the audit trail
   * is canonical.
   */
  async create(
    studentId: string,
    input: CreateCoordinatedCareNoteDto,
    actor: ResolvedActor,
  ): Promise<CoordinatedCareNoteDto> {
    await this.assertIntersectionAccess(actor);
    if (!actor.isSchoolAdmin) {
      const tenant = getCurrentTenant();
      if (input.authorRole === 'NURSE') {
        const isNurse = await this.permissions.hasAnyPermissionInTenant(
          actor.accountId,
          tenant.schoolId,
          ['hlt-001:write'],
        );
        if (!isNurse) {
          throw new BadRequestException(
            'authorRole=NURSE requires hlt-001:write — only nurses (and admins) can post a NURSE note',
          );
        }
      } else if (input.authorRole === 'COUNSELLOR') {
        const isCounsellor = await this.permissions.hasAnyPermissionInTenant(
          actor.accountId,
          tenant.schoolId,
          ['cou-001:write', 'cou-007:write'],
        );
        if (!isCounsellor) {
          throw new BadRequestException(
            'authorRole=COUNSELLOR requires cou-001:write or cou-007:write — only counsellors (and admins) can post a COUNSELLOR note',
          );
        }
      }
    }
    // Validate student exists.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        studentId,
      )) as Array<{ ok: number }>;
      if (r.length === 0) throw new NotFoundException('Student ' + studentId);
    });
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_coordinated_care_notes (id, student_id, author_person_id, author_role, note_text) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
        id,
        studentId,
        actor.personId,
        input.authorRole,
        input.noteText,
      );
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CareNoteRow[]>(SELECT_NOTE_BASE + 'WHERE n.id = $1::uuid', id);
    });
    return rowToDto(rows[0]!);
  }
}
