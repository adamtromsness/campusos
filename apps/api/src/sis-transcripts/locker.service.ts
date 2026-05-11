import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { decryptCombination, encryptCombination, generateCombination } from './locker-crypto';
import {
  type AssignLockerDto,
  type AssignLockerResponseDto,
  type BulkClearLockersDto,
  type BulkClearLockersResponseDto,
  type CreateLockerDto,
  type LockerDto,
  LOCKER_STATUSES,
  type LockerStatus,
  type StudentLockerDto,
} from './dto/sis-transcripts.dto';

interface LockerRow {
  id: string;
  locker_number: string;
  location_description: string | null;
  combination_encrypted: string | null;
  status: string;
  assigned_to_student_id: string | null;
  assigned_to_student_first_name: string | null;
  assigned_to_student_last_name: string | null;
  assigned_at: string | null;
  academic_year: string | null;
  notes: string | null;
}

/**
 * Locker Service — gated under STU-007 (Locker Management).
 *
 * Combinations are encrypted at rest via AES-256-GCM (locker-crypto.ts).
 * Plaintext is returned exactly once on assign and on student own-locker
 * read. The list view never exposes the combination — hasCombination
 * flag tells the UI whether to surface the request-combination action.
 *
 * Year-end bulk-clear releases every ASSIGNED locker in one tenant tx,
 * clearing assigned_to_student_id + assigned_at + academic_year +
 * combination_encrypted atomically per the assignment_chk lockstep.
 */
@Injectable()
export class LockerService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private rowToDto(r: LockerRow): LockerDto {
    return {
      id: r.id,
      lockerNumber: r.locker_number,
      locationDescription: r.location_description,
      status: r.status as LockerStatus,
      assignedToStudentId: r.assigned_to_student_id,
      assignedToStudentName:
        r.assigned_to_student_first_name && r.assigned_to_student_last_name
          ? `${r.assigned_to_student_first_name} ${r.assigned_to_student_last_name}`
          : null,
      assignedAt: r.assigned_at,
      academicYear: r.academic_year,
      notes: r.notes,
      hasCombination: r.combination_encrypted !== null && r.combination_encrypted !== '',
    };
  }

  private async hasManagerScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-007:write',
      'stu-007:admin',
    ]);
  }

  private async assertManager(actor: ResolvedActor): Promise<void> {
    if (!(await this.hasManagerScope(actor))) {
      throw new ForbiddenException('Only staff or admins can manage lockers.');
    }
  }

  private async resolveOwnStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      );
      return rows[0]?.id ?? null;
    });
  }

  private buildSelectBase(): string {
    return (
      'SELECT l.id::text, l.locker_number, l.location_description, l.combination_encrypted, ' +
      'l.status, l.assigned_to_student_id::text, ' +
      'ip.first_name AS assigned_to_student_first_name, ip.last_name AS assigned_to_student_last_name, ' +
      'l.assigned_at::text, l.academic_year, l.notes ' +
      'FROM sis_lockers l ' +
      'LEFT JOIN sis_students s ON s.id = l.assigned_to_student_id ' +
      'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'LEFT JOIN platform.iam_person ip ON ip.id = ps.person_id '
    );
  }

  // ─── Reads ───

  async list(
    args: { status?: string; includeCombinationFlag?: boolean },
    actor: ResolvedActor,
  ): Promise<LockerDto[]> {
    await this.assertManager(actor);
    const tenant = getCurrentTenant();
    const conditions: string[] = ['l.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    let next = 2;
    if (args.status) {
      if (!LOCKER_STATUSES.includes(args.status as LockerStatus)) {
        throw new BadRequestException(`status must be one of ${LOCKER_STATUSES.join(', ')}`);
      }
      conditions.push(`l.status = $${next}`);
      params.push(args.status);
      next += 1;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<LockerRow[]>(
        this.buildSelectBase() + 'WHERE ' + conditions.join(' AND ') + ' ORDER BY l.locker_number',
        ...params,
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async getStudentLocker(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<StudentLockerDto | null> {
    // Row scope — only the owning student, linked guardian, or staff/admin
    // may resolve the combination plaintext.
    let allowed = false;
    if (await this.hasManagerScope(actor)) {
      allowed = true;
    } else if (actor.personType === 'STUDENT') {
      const ownId = await this.resolveOwnStudentId(actor);
      if (ownId === studentId) allowed = true;
    } else if (actor.personType === 'GUARDIAN') {
      const linked = await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        ),
      );
      if (linked.length > 0) allowed = true;
    }
    if (!allowed) {
      throw new NotFoundException('Locker not found');
    }
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<LockerRow[]>(
        this.buildSelectBase() +
          "WHERE l.school_id = $1::uuid AND l.assigned_to_student_id = $2::uuid AND l.status = 'ASSIGNED' LIMIT 1",
        tenant.schoolId,
        studentId,
      ),
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    const base = this.rowToDto(r);
    const combination = decryptCombination(r.combination_encrypted);
    return { ...base, combination };
  }

  // ─── Writes ───

  async create(dto: CreateLockerDto, actor: ResolvedActor): Promise<LockerDto> {
    await this.assertManager(actor);
    if (!dto.lockerNumber || dto.lockerNumber.trim() === '') {
      throw new BadRequestException('lockerNumber is required');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$executeRawUnsafe(
          'INSERT INTO sis_lockers (id, school_id, locker_number, location_description, status, notes) ' +
            "VALUES ($1::uuid, $2::uuid, $3, $4, 'AVAILABLE', $5)",
          id,
          tenant.schoolId,
          dto.lockerNumber.trim(),
          dto.locationDescription ?? null,
          dto.notes ?? null,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('sis_lockers_unique')) {
        throw new BadRequestException(`Locker ${dto.lockerNumber} already exists.`);
      }
      throw err;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<LockerRow[]>(
        this.buildSelectBase() + 'WHERE l.id = $1::uuid AND l.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    return this.rowToDto(rows[0]!);
  }

  async assign(dto: AssignLockerDto, actor: ResolvedActor): Promise<AssignLockerResponseDto> {
    await this.assertManager(actor);
    if (!dto.academicYear || dto.academicYear.trim() === '') {
      throw new BadRequestException('academicYear is required');
    }
    const tenant = getCurrentTenant();

    // Verify the student belongs to this school.
    const studentRows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        dto.studentId,
        tenant.schoolId,
      ),
    );
    if (studentRows.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }

    const combinationPlaintext = (dto.combination ?? generateCombination()).trim();
    if (combinationPlaintext === '') {
      throw new BadRequestException('combination cannot be empty');
    }
    const ciphertext = encryptCombination(combinationPlaintext);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C13 MAJOR 2 — lock binds school predicate baked into the
      // SELECT FOR UPDATE so a foreign-school locker UUID returns 0 rows.
      const rows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT status FROM sis_lockers WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        dto.lockerId,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Locker not found');
      const row = rows[0]!;
      if (row.status === 'ASSIGNED') {
        throw new BadRequestException(
          'Locker is already ASSIGNED. Release it first via /sis/lockers/:id/release.',
        );
      }
      if (row.status === 'OUT_OF_SERVICE') {
        throw new BadRequestException('Locker is OUT_OF_SERVICE and cannot be assigned.');
      }
      await tx.$executeRawUnsafe(
        "UPDATE sis_lockers SET status = 'ASSIGNED', " +
          'assigned_to_student_id = $1::uuid, assigned_at = current_date, ' +
          'academic_year = $2, combination_encrypted = $3, updated_at = now() ' +
          'WHERE id = $4::uuid AND school_id = $5::uuid',
        dto.studentId,
        dto.academicYear,
        ciphertext,
        dto.lockerId,
        tenant.schoolId,
      );
    });

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<LockerRow[]>(
        this.buildSelectBase() + 'WHERE l.id = $1::uuid AND l.school_id = $2::uuid LIMIT 1',
        dto.lockerId,
        tenant.schoolId,
      ),
    );
    return { locker: this.rowToDto(rows[0]!), combination: combinationPlaintext };
  }

  async release(id: string, actor: ResolvedActor): Promise<LockerDto> {
    await this.assertManager(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C13 MAJOR 2 — lock now binds school predicate into the
      // SELECT FOR UPDATE so a foreign-school locker UUID never even
      // enters the locked-row check.
      const rows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT status FROM sis_lockers WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Locker not found');
      const row = rows[0]!;
      if (row.status !== 'ASSIGNED') {
        throw new BadRequestException(
          `Cannot release a locker in status ${row.status}. Only ASSIGNED lockers can be released.`,
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE sis_lockers SET status = 'AVAILABLE', " +
          'assigned_to_student_id = NULL, assigned_at = NULL, academic_year = NULL, ' +
          'combination_encrypted = NULL, updated_at = now() ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<LockerRow[]>(
        this.buildSelectBase() + 'WHERE l.id = $1::uuid AND l.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    return this.rowToDto(rows[0]!);
  }

  async bulkClear(
    dto: BulkClearLockersDto,
    actor: ResolvedActor,
  ): Promise<BulkClearLockersResponseDto> {
    await this.assertManager(actor);
    const tenant = getCurrentTenant();
    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const conditions: string[] = ['school_id = $1::uuid', "status = 'ASSIGNED'"];
      const params: unknown[] = [tenant.schoolId];
      if (dto.academicYear) {
        conditions.push('academic_year = $2');
        params.push(dto.academicYear);
      }
      // Phase 1 — lock matching rows.
      const matches = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM sis_lockers WHERE ${conditions.join(' AND ')} FOR UPDATE`,
        ...params,
      );
      if (matches.length === 0) return 0;
      // Phase 2 — release each row inside the same tx.
      await tx.$executeRawUnsafe(
        `UPDATE sis_lockers SET status = 'AVAILABLE', ` +
          'assigned_to_student_id = NULL, assigned_at = NULL, academic_year = NULL, ' +
          'combination_encrypted = NULL, updated_at = now() ' +
          `WHERE ${conditions.join(' AND ')}`,
        ...params,
      );
      return matches.length;
    });
    return { cleared: result };
  }

  async markOutOfService(id: string, actor: ResolvedActor): Promise<LockerDto> {
    await this.assertManager(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C13 MAJOR 2 — lock now binds school predicate into the
      // SELECT FOR UPDATE so a foreign-school locker UUID never even
      // enters the locked-row check.
      const rows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT status FROM sis_lockers WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Locker not found');
      const row = rows[0]!;
      if (row.status === 'ASSIGNED') {
        throw new BadRequestException('Release the locker before marking it OUT_OF_SERVICE.');
      }
      await tx.$executeRawUnsafe(
        "UPDATE sis_lockers SET status = 'OUT_OF_SERVICE', " +
          'assigned_to_student_id = NULL, assigned_at = NULL, academic_year = NULL, ' +
          'combination_encrypted = NULL, updated_at = now() ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<LockerRow[]>(
        this.buildSelectBase() + 'WHERE l.id = $1::uuid AND l.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    return this.rowToDto(rows[0]!);
  }

  async markAvailable(id: string, actor: ResolvedActor): Promise<LockerDto> {
    await this.assertManager(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C13 MAJOR 2 — lock now binds school predicate into the
      // SELECT FOR UPDATE so a foreign-school locker UUID never even
      // enters the locked-row check.
      const rows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT status FROM sis_lockers WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Locker not found');
      const row = rows[0]!;
      if (row.status === 'ASSIGNED') {
        throw new BadRequestException(
          'Locker is ASSIGNED. Release it via /sis/lockers/:id/release before re-flagging AVAILABLE.',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE sis_lockers SET status = 'AVAILABLE', " +
          'assigned_to_student_id = NULL, assigned_at = NULL, academic_year = NULL, ' +
          'combination_encrypted = NULL, updated_at = now() ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<LockerRow[]>(
        this.buildSelectBase() + 'WHERE l.id = $1::uuid AND l.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    return this.rowToDto(rows[0]!);
  }
}
