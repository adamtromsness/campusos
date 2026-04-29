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
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { InvoiceService } from './invoice.service';
import {
  CreateInvoiceDto,
  GenerateFromScheduleDto,
  GenerateFromScheduleResponseDto,
  InvoiceResponseDto,
  ListInvoicesQueryDto,
} from './dto/invoice.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Payments: Invoices')
@ApiBearerAuth()
@Controller('invoices')
export class InvoiceController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List invoices (admin: all, parent: own family)' })
  async list(
    @Query() query: ListInvoicesQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<InvoiceResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invoices.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'Get an invoice (with line items)' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<InvoiceResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invoices.getById(id, actor);
  }

  @Post()
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Create a DRAFT invoice (admin only)' })
  async create(
    @Body() body: CreateInvoiceDto,
    @Req() req: AuthedRequest,
  ): Promise<InvoiceResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invoices.create(body, actor);
  }

  @Patch(':id/send')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'Send a DRAFT invoice (admin only). Locks row, flips DRAFT→SENT, writes CHARGE ledger entry, emits pay.invoice.created.',
  })
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<InvoiceResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invoices.send(id, actor);
  }

  @Patch(':id/cancel')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Cancel an invoice (admin only)' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<InvoiceResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invoices.cancel(id, actor);
  }

  @Post('generate-from-schedule')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'Bulk-generate DRAFT invoices for every linked family from a fee schedule (admin only)',
  })
  async generateFromSchedule(
    @Body() body: GenerateFromScheduleDto,
    @Req() req: AuthedRequest,
  ): Promise<GenerateFromScheduleResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.invoices.generateFromSchedule(body, actor);
  }
}
