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
import { ProgrammeService } from './programme.service';
import {
  CreateGameProposalDto,
  GameProposalResponseDto,
  ProposalLocation,
  ProposalStatus,
  RespondGameProposalDto,
  RosterLevel,
} from './dto/athletics.dto';

interface ProposalRow {
  id: string;
  proposing_school_id: string;
  receiving_school_id: string;
  proposing_roster_id: string | null;
  sport: string;
  level: string;
  proposed_date: string;
  proposed_time: string | null;
  proposed_location: string;
  notes: string | null;
  status: string;
  counter_proposal_data: Record<string, unknown> | null;
  confirmed_game_id: string | null;
  proposed_by: string | null;
  responded_by: string | null;
  responded_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_PROPOSAL =
  'SELECT id::text AS id, proposing_school_id::text AS proposing_school_id, ' +
  'receiving_school_id::text AS receiving_school_id, proposing_roster_id::text AS proposing_roster_id, ' +
  "sport, level, TO_CHAR(proposed_date, 'YYYY-MM-DD') AS proposed_date, " +
  "TO_CHAR(proposed_time, 'HH24:MI') AS proposed_time, proposed_location, notes, status, " +
  'counter_proposal_data, confirmed_game_id::text AS confirmed_game_id, ' +
  'proposed_by::text AS proposed_by, responded_by::text AS responded_by, ' +
  'TO_CHAR(responded_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS responded_at, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_game_proposals ';

function rowToDto(r: ProposalRow): GameProposalResponseDto {
  return {
    id: r.id,
    proposingSchoolId: r.proposing_school_id,
    receivingSchoolId: r.receiving_school_id,
    proposingRosterId: r.proposing_roster_id,
    sport: r.sport,
    level: r.level as RosterLevel,
    proposedDate: r.proposed_date,
    proposedTime: r.proposed_time,
    proposedLocation: r.proposed_location as ProposalLocation,
    notes: r.notes,
    status: r.status as ProposalStatus,
    counterProposalData: r.counter_proposal_data,
    confirmedGameId: r.confirmed_game_id,
    proposedBy: r.proposed_by,
    respondedBy: r.responded_by,
    respondedAt: r.responded_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class GameProposalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly programmes: ProgrammeService,
  ) {}

  async list(actor: ResolvedActor): Promise<GameProposalResponseDto[]> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can view game proposals');
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PROPOSAL +
          'WHERE proposing_school_id = $1::uuid OR receiving_school_id = $1::uuid ' +
          'ORDER BY created_at DESC LIMIT 200',
        tenant.schoolId,
      );
    })) as ProposalRow[];
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<GameProposalResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_PROPOSAL + 'WHERE id = $1::uuid', id);
    })) as ProposalRow[];
    if (rows.length === 0) throw new NotFoundException('Game proposal not found');
    return rowToDto(rows[0]!);
  }

  async create(
    input: CreateGameProposalDto,
    actor: ResolvedActor,
  ): Promise<GameProposalResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can propose games');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO ath_game_proposals (id, proposing_school_id, receiving_school_id, proposing_roster_id, sport, level, proposed_date, proposed_time, proposed_location, notes, status, proposed_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date, $8::time, $9, $10, 'PROPOSED', $11::uuid)",
        id,
        tenant.schoolId,
        input.receivingSchoolId,
        input.proposingRosterId ?? null,
        input.sport,
        input.level,
        input.proposedDate,
        input.proposedTime ?? null,
        input.proposedLocation,
        input.notes ?? null,
        actor.employeeId,
      );
    });
    return this.getById(id);
  }

  async accept(id: string, actor: ResolvedActor): Promise<GameProposalResponseDto> {
    return this.transition(id, 'ACCEPTED', actor);
  }

  async decline(id: string, actor: ResolvedActor): Promise<GameProposalResponseDto> {
    return this.transition(id, 'DECLINED', actor);
  }

  async counter(
    id: string,
    body: RespondGameProposalDto,
    actor: ResolvedActor,
  ): Promise<GameProposalResponseDto> {
    return this.transition(id, 'COUNTER_PROPOSED', actor, body.counterProposalData);
  }

  private async transition(
    id: string,
    status: ProposalStatus,
    actor: ResolvedActor,
    counterData?: Record<string, unknown>,
  ): Promise<GameProposalResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can respond to game proposals');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Proposal response requires an hr_employees identity');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        "SELECT status FROM ath_game_proposals WHERE id = $1::uuid AND status = 'PROPOSED' FOR UPDATE",
        id,
      )) as Array<{ status: string }>;
      if (lock.length === 0) {
        throw new BadRequestException(
          'Proposal not found or no longer in PROPOSED state. Reload and try again.',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE ath_game_proposals SET status = $1, responded_by = $2::uuid, responded_at = now(), counter_proposal_data = $3::jsonb, updated_at = now() WHERE id = $4::uuid',
        status,
        actor.employeeId,
        counterData ? JSON.stringify(counterData) : null,
        id,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_PROPOSAL + 'WHERE id = $1::uuid',
        id,
      )) as ProposalRow[];
      return rowToDto(rows[0]!);
    });
  }
}
