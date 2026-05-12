import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CoteachingResponseDto,
  CreateCoteachingDto,
  UpdateCoteachingDto,
} from './dto/scheduling-advanced-b.dto';

/*
 * CoTeachingService — P2-17b.
 *
 * Owns sch_coteaching_arrangements. The keystone — the schema EXCLUSION
 * on sch_timetable_slots (teacher_id period_id daterange) catches the
 * primary teacher's double-booking. A secondary teacher referenced in
 * this table is exempt at the service layer for the matching slot.
 *
 * REVIEW-P2C17 BLOCKING 3 — every list/get/create/patch/delete path now
 * joins through sch_timetable_slots and gates on
 * sch_timetable_slots.school_id = tenant.schoolId. create() also
 * validates both primary + secondary teachers belong to the current
 * school via hr_employees.school_id. A School A scheduler can no
 * longer mutate a School B arrangement by knowing the UUID.
 */

interface CoteachingRow {
  id: string;
  timetable_slot_id: string;
  primary_teacher_id: string;
  secondary_teacher_id: string;
  teaching_model: string;
  effective_from: string | null;
  effective_to: string | null;
  notes: string | null;
}

const SELECT_BASE =
  'SELECT ca.id::text AS id, ca.timetable_slot_id::text AS timetable_slot_id, ' +
  'ca.primary_teacher_id::text AS primary_teacher_id, ca.secondary_teacher_id::text AS secondary_teacher_id, ' +
  'ca.teaching_model, ' +
  "to_char(ca.effective_from, 'YYYY-MM-DD') AS effective_from, " +
  "to_char(ca.effective_to, 'YYYY-MM-DD') AS effective_to, ca.notes " +
  'FROM sch_coteaching_arrangements ca ' +
  'JOIN sch_timetable_slots s ON s.id = ca.timetable_slot_id ';

function rowToDto(row: CoteachingRow): CoteachingResponseDto {
  return {
    id: row.id,
    timetableSlotId: row.timetable_slot_id,
    primaryTeacherId: row.primary_teacher_id,
    secondaryTeacherId: row.secondary_teacher_id,
    teachingModel: row.teaching_model as CoteachingResponseDto['teachingModel'],
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    notes: row.notes,
  };
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string } };
  return err.code === 'P2010' || err.meta?.code === '23505';
}

@Injectable()
export class CoTeachingService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertAdmin(actor: ResolvedActor): void {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Co-teaching arrangements require sch-001:admin (school admin).',
      );
    }
  }

  async list(slotId?: string): Promise<CoteachingResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = slotId
        ? await client.$queryRawUnsafe<CoteachingRow[]>(
            SELECT_BASE +
              'WHERE ca.timetable_slot_id = $1::uuid AND s.school_id = $2::uuid ' +
              'ORDER BY ca.created_at DESC',
            slotId,
            tenant.schoolId,
          )
        : await client.$queryRawUnsafe<CoteachingRow[]>(
            SELECT_BASE + 'WHERE s.school_id = $1::uuid ORDER BY ca.created_at DESC',
            tenant.schoolId,
          );
      return rows.map(rowToDto);
    });
  }

  async getById(id: string): Promise<CoteachingResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<CoteachingRow[]>(
        SELECT_BASE + 'WHERE ca.id = $1::uuid AND s.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Co-teaching arrangement not found');
      return rowToDto(rows[0]!);
    });
  }

  async create(body: CreateCoteachingDto, actor: ResolvedActor): Promise<CoteachingResponseDto> {
    this.assertAdmin(actor);
    if (body.primaryTeacherId === body.secondaryTeacherId) {
      throw new BadRequestException('Primary and secondary teacher must be different employees.');
    }

    const tenant = getCurrentTenant();

    // REVIEW-P2C17 BLOCKING 3 — validate slot belongs to current
    // school AND both teachers belong to current school. A School A
    // admin who supplies a School B slot UUID or School B teacher
    // UUID now gets 400 BEFORE any insert lands.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const refs = await client.$queryRawUnsafe<
        Array<{ slot_ok: boolean; primary_ok: boolean; secondary_ok: boolean }>
      >(
        'SELECT ' +
          '(EXISTS (SELECT 1 FROM sch_timetable_slots WHERE id = $1::uuid AND school_id = $4::uuid)) AS slot_ok, ' +
          '(EXISTS (SELECT 1 FROM hr_employees WHERE id = $2::uuid AND school_id = $4::uuid)) AS primary_ok, ' +
          '(EXISTS (SELECT 1 FROM hr_employees WHERE id = $3::uuid AND school_id = $4::uuid)) AS secondary_ok',
        body.timetableSlotId,
        body.primaryTeacherId,
        body.secondaryTeacherId,
        tenant.schoolId,
      );
      const r = refs[0]!;
      if (!r.slot_ok) {
        throw new BadRequestException('timetableSlotId does not match a slot in this school.');
      }
      if (!r.primary_ok) {
        throw new BadRequestException(
          'primaryTeacherId does not match an employee in this school.',
        );
      }
      if (!r.secondary_ok) {
        throw new BadRequestException(
          'secondaryTeacherId does not match an employee in this school.',
        );
      }
    });

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_coteaching_arrangements (id, timetable_slot_id, primary_teacher_id, secondary_teacher_id, teaching_model, effective_from, effective_to, notes, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date, $7::date, $8, $9::uuid)',
          id,
          body.timetableSlotId,
          body.primaryTeacherId,
          body.secondaryTeacherId,
          body.teachingModel,
          body.effectiveFrom ?? null,
          body.effectiveTo ?? null,
          body.notes ?? null,
          actor.accountId,
        );
      });
    } catch (e: unknown) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          'This secondary teacher is already paired with this slot — edit the existing arrangement instead.',
        );
      }
      const err = e as { meta?: { code?: string; message?: string } };
      if (err.meta?.code === '23514') {
        throw new BadRequestException(
          err.meta.message ?? 'Co-teaching arrangement rejected by schema CHECK.',
        );
      }
      throw e;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    body: UpdateCoteachingDto,
    actor: ResolvedActor,
  ): Promise<CoteachingResponseDto> {
    this.assertAdmin(actor);
    // REVIEW-P2C17 BLOCKING 3 — confirm the arrangement belongs to
    // the current school via getById's join-through-slot before
    // mutating. getById throws 404 don't-leak-existence on miss.
    await this.getById(id);

    const sets: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (body.teachingModel !== undefined) {
      sets.push('teaching_model = $' + i);
      args.push(body.teachingModel);
      i += 1;
    }
    if (body.effectiveFrom !== undefined) {
      sets.push('effective_from = $' + i + '::date');
      args.push(body.effectiveFrom);
      i += 1;
    }
    if (body.effectiveTo !== undefined) {
      sets.push('effective_to = $' + i + '::date');
      args.push(body.effectiveTo);
      i += 1;
    }
    if (body.notes !== undefined) {
      sets.push('notes = $' + i);
      args.push(body.notes);
      i += 1;
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    args.push(id);

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE sch_coteaching_arrangements SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          i +
          '::uuid',
        ...args,
      );
    });
    return this.getById(id);
  }

  async remove(id: string, actor: ResolvedActor): Promise<void> {
    this.assertAdmin(actor);
    // REVIEW-P2C17 BLOCKING 3 — confirm school ownership BEFORE
    // delete. getById throws 404 if the arrangement is in a foreign
    // school — the DELETE never fires.
    await this.getById(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM sch_coteaching_arrangements WHERE id = $1::uuid',
        id,
      );
    });
  }

  /**
   * True if the given (slot, teacher) pair is recorded as a co-teaching
   * arrangement on the slot AND the slot belongs to the current
   * school — TimetableService can call this when validating a new
   * slot to decide whether to relax the secondary teacher's
   * double-booking check.
   */
  async hasActiveCoTeachingFor(slotId: string, teacherId: string): Promise<boolean> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<{ id: string }[]>(
        'SELECT ca.id::text AS id FROM sch_coteaching_arrangements ca ' +
          'JOIN sch_timetable_slots s ON s.id = ca.timetable_slot_id ' +
          'WHERE ca.timetable_slot_id = $1::uuid AND ca.secondary_teacher_id = $2::uuid AND s.school_id = $3::uuid LIMIT 1',
        slotId,
        teacherId,
        tenant.schoolId,
      );
    });
    return rows.length > 0;
  }
}
