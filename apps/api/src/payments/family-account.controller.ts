import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { FamilyAccountService } from './family-account.service';
import { LedgerService } from './ledger.service';
import { FamilyAccountResponseDto, FamilyAccountStudentDto } from './dto/family-account.dto';
import { LedgerBalanceDto, LedgerEntryDto, ListLedgerQueryDto } from './dto/ledger.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Payments: Family Accounts')
@ApiBearerAuth()
@Controller('family-accounts')
export class FamilyAccountController {
  constructor(
    private readonly accounts: FamilyAccountService,
    private readonly ledger: LedgerService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List family accounts (admin: all, parent: own)' })
  async list(@Req() req: AuthedRequest): Promise<FamilyAccountResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.accounts.list(actor);
  }

  @Get(':id')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'Get a family account with linked students + balance' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FamilyAccountResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.accounts.getById(id, actor);
  }

  @Get(':id/students')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List students linked to a family account' })
  async listStudents(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FamilyAccountStudentDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.accounts.listStudents(id, actor);
  }

  @Get(':id/balance')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'Current account balance (Redis-cached, TTL=30s)' })
  async getBalance(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<LedgerBalanceDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    // Reuse the row-scope check on the account read.
    await this.accounts.getById(id, actor);
    return this.ledger.getBalance(id);
  }

  @Get(':id/ledger')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'Paginated ledger entries newest-first' })
  async listLedger(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListLedgerQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<LedgerEntryDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.accounts.getById(id, actor);
    return this.ledger.listEntries(id, query);
  }
}
