import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { ProgrammeService } from './programme.service';
import {
  CompleteProtocolStepDto,
  ConcussionProtocolStepDto,
  StartProtocolStepDto,
} from './dto/athletics.dto';

interface StepRow {
  id: string;
  injury_id: string;
  step_number: number;
  step_name: string;
  started_at: string;
  minimum_duration_hours: number;
  completed_at: string | null;
  symptom_free: boolean;
  cleared_by: string | null;
  cleared_by_name: string | null;
  notes: string | null;
}

const SELECT_STEP =
  'SELECT s.id::text AS id, s.injury_id::text AS injury_id, s.step_number, s.step_name, ' +
  'TO_CHAR(s.started_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS started_at, ' +
  's.minimum_duration_hours, ' +
  'TO_CHAR(s.completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, ' +
  's.symptom_free, s.cleared_by::text AS cleared_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees he " +
  '  JOIN platform.iam_person ip ON ip.id = he.person_id ' +
  '  WHERE he.id = s.cleared_by) AS cleared_by_name, ' +
  's.notes FROM ath_concussion_protocol_steps s ';

function rowToDto(r: StepRow, canStartNext: boolean): ConcussionProtocolStepDto {
  return {
    id: r.id,
    injuryId: r.injury_id,
    stepNumber: r.step_number,
    stepName: r.step_name,
    startedAt: r.started_at,
    minimumDurationHours: r.minimum_duration_hours,
    completedAt: r.completed_at,
    symptomFree: r.symptom_free,
    clearedBy: r.cleared_by,
    clearedByName: r.cleared_by_name,
    notes: r.notes,
    canStartNext,
  };
}

@Injectable()
export class ConcussionProtocolService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly programmes: ProgrammeService,
  ) {}

  async listForInjury(injuryId: string): Promise<ConcussionProtocolStepDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_STEP + 'WHERE s.injury_id = $1::uuid ORDER BY s.step_number ASC',
        injuryId,
      );
    })) as StepRow[];
    return rows.map((r) => rowToDto(r, this.canStartNextAfter(r, rows)));
  }

  /**
   * SAFETY KEYSTONE.  Step N+1 cannot start until step N is
   * (a) completed AND (b) the minimum_duration_hours has elapsed
   * AND (c) symptom_free=true.
   */
  async startStep(
    injuryId: string,
    input: StartProtocolStepDto,
    actor: ResolvedActor,
  ): Promise<ConcussionProtocolStepDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can manage the concussion protocol');
    }

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the injury row so concurrent starts serialise
      const inj = (await tx.$queryRawUnsafe(
        "SELECT id, return_to_play_status FROM ath_injuries WHERE id = $1::uuid AND return_to_play_status = 'CONCUSSION_PROTOCOL' FOR UPDATE",
        injuryId,
      )) as Array<{ id: string; return_to_play_status: string }>;
      if (inj.length === 0) {
        throw new BadRequestException(
          'Injury not found or not in CONCUSSION_PROTOCOL state. The protocol applies only when return_to_play_status = CONCUSSION_PROTOCOL.',
        );
      }

      // Cannot create out-of-order steps
      if (input.stepNumber > 1) {
        const prev = (await tx.$queryRawUnsafe(
          'SELECT id, completed_at, symptom_free, started_at, minimum_duration_hours ' +
            'FROM ath_concussion_protocol_steps ' +
            'WHERE injury_id = $1::uuid AND step_number = $2',
          injuryId,
          input.stepNumber - 1,
        )) as Array<{
          id: string;
          completed_at: string | null;
          symptom_free: boolean;
          started_at: string;
          minimum_duration_hours: number;
        }>;
        if (prev.length === 0) {
          throw new BadRequestException(
            'Cannot start step ' +
              input.stepNumber +
              ' before step ' +
              (input.stepNumber - 1) +
              ' exists.',
          );
        }
        if (prev[0]!.completed_at === null) {
          throw new BadRequestException(
            'Cannot start step ' + input.stepNumber + ' until the previous step is completed.',
          );
        }
        if (!prev[0]!.symptom_free) {
          throw new BadRequestException(
            'Cannot progress past step ' +
              (input.stepNumber - 1) +
              ' until the athlete is symptom_free.',
          );
        }
        const elapsedHours =
          (new Date().getTime() - new Date(prev[0]!.started_at).getTime()) / 1000 / 60 / 60;
        if (elapsedHours < prev[0]!.minimum_duration_hours) {
          throw new BadRequestException(
            'Minimum duration of ' +
              prev[0]!.minimum_duration_hours +
              ' hours has not elapsed since step ' +
              (input.stepNumber - 1) +
              ' started. Wait before starting step ' +
              input.stepNumber +
              '.',
          );
        }
      }

      const id = generateId();
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO ath_concussion_protocol_steps (id, injury_id, step_number, step_name, minimum_duration_hours, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
          id,
          injuryId,
          input.stepNumber,
          input.stepName,
          input.minimumDurationHours ?? 24,
          input.notes ?? null,
        );
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '23505') {
          throw new BadRequestException(
            'Step ' + input.stepNumber + ' already exists for this injury.',
          );
        }
        if (code === '23514') {
          throw new BadRequestException('step_number must be between 1 and 6.');
        }
        throw e;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_STEP + 'WHERE s.id = $1::uuid',
        id,
      )) as StepRow[];
      return rowToDto(rows[0]!, false);
    });
  }

  async completeStep(
    stepId: string,
    input: CompleteProtocolStepDto,
    actor: ResolvedActor,
  ): Promise<ConcussionProtocolStepDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can complete protocol steps');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Completing a protocol step requires an hr_employees identity');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, completed_at, started_at, minimum_duration_hours FROM ath_concussion_protocol_steps WHERE id = $1::uuid FOR UPDATE',
        stepId,
      )) as Array<{
        id: string;
        completed_at: string | null;
        started_at: string;
        minimum_duration_hours: number;
      }>;
      if (lock.length === 0) throw new NotFoundException('Protocol step not found');
      if (lock[0]!.completed_at !== null) {
        throw new BadRequestException('Step is already completed.');
      }
      const elapsedHours =
        (new Date().getTime() - new Date(lock[0]!.started_at).getTime()) / 1000 / 60 / 60;
      if (elapsedHours < lock[0]!.minimum_duration_hours) {
        throw new BadRequestException(
          'Minimum duration of ' +
            lock[0]!.minimum_duration_hours +
            ' hours has not yet elapsed since this step started. Wait before completing.',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE ath_concussion_protocol_steps SET completed_at = now(), symptom_free = $1, ' +
          'cleared_by = $2::uuid, notes = COALESCE($3, notes), updated_at = now() WHERE id = $4::uuid',
        input.symptomFree,
        actor.employeeId,
        input.notes ?? null,
        stepId,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_STEP + 'WHERE s.id = $1::uuid',
        stepId,
      )) as StepRow[];
      return rowToDto(rows[0]!, true);
    });
  }

  private canStartNextAfter(step: StepRow, allSteps: StepRow[]): boolean {
    if (step.completed_at === null) return false;
    if (!step.symptom_free) return false;
    const elapsedHours =
      (new Date().getTime() - new Date(step.started_at).getTime()) / 1000 / 60 / 60;
    if (elapsedHours < step.minimum_duration_hours) return false;
    if (step.step_number >= 6) return false;
    // and the next step must not yet exist
    const next = allSteps.find((s) => s.step_number === step.step_number + 1);
    return !next;
  }
}
