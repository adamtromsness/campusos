import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { LunchAccountService } from './lunch-account.service';
import {
  DepositLunchAccountDto,
  LunchAccountResponseDto,
  LunchAccountWithTransactionsDto,
  LunchTransactionResponseDto,
  LunchTransferResponseDto,
  TransferLunchBalanceDto,
  UpdateLunchAccountDto,
} from './dto/lunch-account.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Payments: Lunch Accounts')
@ApiBearerAuth()
@Controller('payments/lunch-accounts')
export class LunchAccountController {
  constructor(
    private readonly lunch: LunchAccountService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('low-balance')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary: 'List lunch accounts at or below their low_balance_threshold (admin only)',
  })
  async listLowBalance(@Req() req: AuthedRequest): Promise<LunchAccountResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lunch.listLowBalance(actor);
  }

  @Post('transfer')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'IMMUTABLE balance transfer (SIBLING_TRANSFER, NEXT_YEAR_ROLLOVER, or REFUND_TO_FAMILY). No update or delete service paths exist — corrections are made by creating offsetting transfers.',
  })
  async transfer(
    @Body() body: TransferLunchBalanceDto,
    @Req() req: AuthedRequest,
  ): Promise<LunchTransferResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lunch.transfer(body, actor);
  }

  @Get('student/:studentId')
  @RequirePermission('fin-001:read')
  @ApiOperation({
    summary:
      'Get the lunch account for a student plus recent transactions and a low-balance flag. Admin: any student. Parent: own children only via sis_student_guardians. Student: own only.',
  })
  async getForStudent(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query('transactionsLimit') transactionsLimit: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<LunchAccountWithTransactionsDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const limit = transactionsLimit ? parseInt(transactionsLimit, 10) : undefined;
    return this.lunch.getForStudent(studentId, actor, { transactionsLimit: limit });
  }

  @Post(':id/deposit')
  @RequirePermission('fin-001:write')
  @ApiOperation({ summary: 'Deposit funds into a lunch account (parent or admin)' })
  async deposit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DepositLunchAccountDto,
    @Req() req: AuthedRequest,
  ): Promise<LunchTransactionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lunch.deposit(id, body, actor);
  }

  @Patch(':id/settings')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Update lunch account settings (admin only)' })
  async updateSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLunchAccountDto,
    @Req() req: AuthedRequest,
  ): Promise<LunchAccountResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lunch.update(id, body, actor);
  }
}
