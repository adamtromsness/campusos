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
import { HealthAccessLogService } from './health-access-log.service';
import { HealthRecordService } from './health-record.service';
import {
  CreateDietaryProfileDto,
  DietaryAllergenDto,
  DietaryProfileResponseDto,
  UpdateDietaryProfileDto,
} from './dto/health.dto';

interface ProfileRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  dietary_restrictions: string[] | null;
  allergens: DietaryAllergenDto[] | null;
  special_meal_instructions: string | null;
  pos_allergen_alert: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_BASE =
  'SELECT d.id::text AS id, d.school_id::text AS school_id, ' +
  'd.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  'd.dietary_restrictions, d.allergens, d.special_meal_instructions, ' +
  'd.pos_allergen_alert, d.updated_by::text AS updated_by, ' +
  'TO_CHAR(d.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(d.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_dietary_profiles d ' +
  'JOIN sis_students s ON s.id = d.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

/**
 * DietaryProfileService — Cycle 10 Step 7.
 *
 * Per-student dietary profile. Reads gated on `hlt-001:read` so
 * parents (who hold the read tier already) can see their own
 * child's allergens for cafeteria coordination; the service-layer
 * row scope mirrors the Step 5 HealthRecordService pattern. Writes
 * gated on `hlt-005:write` (cafeteria / nurse). The
 * `GET /health/allergen-alerts` endpoint is the canonical surface
 * the future POS / cafeteria integration polls — admin-only via
 * hlt-005:admin.
 */
@Injectable()
export class DietaryProfileService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly accessLog: HealthAccessLogService,
    private readonly records: HealthRecordService,
  ) {}

  async getForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<DietaryProfileResponseDto | null> {
    await this.records.assertCanReadStudentExternal(studentId, actor);
    const row = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE d.student_id = $1::uuid LIMIT 1',
        studentId,
      )) as ProfileRow[];
      return rows[0] ?? null;
    });
    if (!row) return null;
    await this.accessLog.recordAccess(actor, studentId, 'VIEW_DIETARY');
    return this.rowToDto(row);
  }

  async create(
    studentId: string,
    input: CreateDietaryProfileDto,
    actor: ResolvedActor,
  ): Promise<DietaryProfileResponseDto> {
    await this.records.assertNurseScope(actor);
    if (!(await this.studentExistsInTenant(studentId))) {
      throw new NotFoundException('Student ' + studentId);
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO hlth_dietary_profiles ' +
            '(id, school_id, student_id, dietary_restrictions, allergens, special_meal_instructions, pos_allergen_alert, updated_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], $5::jsonb, $6, $7, $8::uuid)',
          id,
          tenant.schoolId,
          studentId,
          input.dietaryRestrictions ?? [],
          JSON.stringify(input.allergens ?? []),
          input.specialMealInstructions ?? null,
          input.posAllergenAlert ?? false,
          actor.accountId,
        );
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new BadRequestException(
          'Student ' + studentId + ' already has a dietary profile. Use PATCH to update.',
        );
      }
      throw err;
    }
    return this.loadOrFail(id);
  }

  async update(
    id: string,
    input: UpdateDietaryProfileDto,
    actor: ResolvedActor,
  ): Promise<DietaryProfileResponseDto> {
    await this.records.assertNurseScope(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.dietaryRestrictions !== undefined) {
      sets.push('dietary_restrictions = $' + idx + '::text[]');
      params.push(input.dietaryRestrictions);
      idx++;
    }
    if (input.allergens !== undefined) {
      sets.push('allergens = $' + idx + '::jsonb');
      params.push(JSON.stringify(input.allergens));
      idx++;
    }
    if (input.specialMealInstructions !== undefined) {
      sets.push('special_meal_instructions = $' + idx);
      params.push(input.specialMealInstructions);
      idx++;
    }
    if (input.posAllergenAlert !== undefined) {
      sets.push('pos_allergen_alert = $' + idx);
      params.push(input.posAllergenAlert);
      idx++;
    }
    sets.push('updated_by = $' + idx + '::uuid');
    params.push(actor.accountId);
    idx++;
    sets.push('updated_at = now()');
    params.push(id);

    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE hlth_dietary_profiles SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    if (result === 0) throw new NotFoundException('Dietary profile ' + id);
    return this.loadOrFail(id);
  }

  /**
   * GET /health/allergen-alerts — the POS / cafeteria integration
   * surface. Returns every student in the school with
   * pos_allergen_alert=true. Hits the Step 3 partial INDEX on
   * (school_id) WHERE pos_allergen_alert=true. Admin / nurse only.
   */
  async listAllergenAlerts(actor: ResolvedActor): Promise<DietaryProfileResponseDto[]> {
    if (!(await this.records.hasNurseScope(actor))) {
      throw new ForbiddenException(
        'The allergen-alerts surface is visible to nurses, counsellors, and admins only',
      );
    }
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_BASE +
          'WHERE d.school_id = $1::uuid AND d.pos_allergen_alert = true ' +
          'ORDER BY sip.last_name ASC, sip.first_name ASC',
        tenant.schoolId,
      )) as ProfileRow[];
    });
    return rows.map((r) => this.rowToDto(r));
  }

  // ─── Internal ────────────────────────────────────────────────

  private async studentExistsInTenant(studentId: string): Promise<boolean> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        studentId,
      )) as Array<{ ok: number }>;
      return rows.length > 0;
    });
  }

  private async loadOrFail(id: string): Promise<DietaryProfileResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE d.id = $1::uuid LIMIT 1',
        id,
      )) as ProfileRow[];
    });
    if (rows.length === 0) throw new NotFoundException('Dietary profile ' + id);
    return this.rowToDto(rows[0]!);
  }

  private rowToDto(r: ProfileRow): DietaryProfileResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      studentId: r.student_id,
      studentName: fullName(r.student_first, r.student_last),
      dietaryRestrictions: r.dietary_restrictions ?? [],
      allergens: r.allergens ?? [],
      specialMealInstructions: r.special_meal_instructions,
      posAllergenAlert: r.pos_allergen_alert,
      updatedById: r.updated_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    const errObj = err as { code?: string; meta?: { code?: string }; message?: string };
    return (
      errObj?.code === 'P2010' ||
      errObj?.meta?.code === '23505' ||
      (typeof errObj?.message === 'string' && errObj.message.includes('23505'))
    );
  }
}
