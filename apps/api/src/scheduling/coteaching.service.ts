import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
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
 * primary teacher's double-booking. A secondary teacher who appears in
 * this table is exempt at the service layer for the matching slot.
 * Other services (TimetableService) call hasActiveCoTeachingFor to
 * decide whether to skip a secondary-teacher conflict check when
 * proposing a new slot — see hasActiveCoTeachingFor below.
 *
 * Note: the existing schema-side EXCLUSION on sch_timetable_slots still
 * catches the primary teacher's double-booking unchanged. The secondary
 * teacher is referenced ONLY in this junction table — they don't appear
 * directly on sch_timetable_slots — so the existing EXCLUSION cannot
 * fire against them anyway. This service is the canonical place that
 * records the second teacher's pairing for a slot.
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
  'SELECT id::text AS id, timetable_slot_id::text AS timetable_slot_id, ' +
  'primary_teacher_id::text AS primary_teacher_id, secondary_teacher_id::text AS secondary_teacher_id, ' +
  'teaching_model, ' +
  "to_char(effective_from, 'YYYY-MM-DD') AS effective_from, " +
  "to_char(effective_to, 'YYYY-MM-DD') AS effective_to, notes " +
  'FROM sch_coteaching_arrangements ';

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
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = slotId
        ? await client.$queryRawUnsafe<CoteachingRow[]>(
            SELECT_BASE + 'WHERE timetable_slot_id = $1::uuid ORDER BY created_at DESC',
            slotId,
          )
        : await client.$queryRawUnsafe<CoteachingRow[]>(SELECT_BASE + 'ORDER BY created_at DESC');
      return rows.map(rowToDto);
    });
  }

  async getById(id: string): Promise<CoteachingResponseDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<CoteachingRow[]>(
        SELECT_BASE + 'WHERE id = $1::uuid',
        id,
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
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM sch_coteaching_arrangements WHERE id = $1::uuid',
        id,
      );
    });
  }

  /**
   * True if the given (slot, teacher) pair is recorded as a co-teaching
   * arrangement on the slot — TimetableService can call this when
   * validating a new slot to decide whether to relax the secondary
   * teacher's double-booking check.
   */
  async hasActiveCoTeachingFor(slotId: string, teacherId: string): Promise<boolean> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM sch_coteaching_arrangements WHERE timetable_slot_id = $1::uuid AND secondary_teacher_id = $2::uuid LIMIT 1',
        slotId,
        teacherId,
      );
    });
    return rows.length > 0;
  }
}
