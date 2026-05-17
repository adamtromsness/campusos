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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import {
  ActorContextService,
  type ResolvedActor,
} from '@modules/m00-platform/iam/actor-context.service';
import { VendorCatalogueService } from './vendor-catalogue.service';
import { ContractService } from './contract.service';
import { SpendingAnalyticsService } from './spending-analytics.service';
import {
  CreateCatalogueItemDto,
  CreateContractAmendmentDto,
  CreateContractDto,
  CreateVendorCatalogueDto,
  SpendingAnalyticsFilterDto,
  UpdateCatalogueItemDto,
  UpdateContractDto,
  UpdateVendorCatalogueDto,
  type ContractStatus,
} from './dto/commerce-advanced.dto';

interface AuthRequest extends Request {
  user?: { accountId: string; personId: string };
}

@ApiTags('Procurement Advanced')
@Controller()
export class ProcurementAdvancedController {
  constructor(
    private readonly actorContext: ActorContextService,
    private readonly catalogues: VendorCatalogueService,
    private readonly contracts: ContractService,
    private readonly analytics: SpendingAnalyticsService,
  ) {}

  private async resolve(req: AuthRequest): Promise<ResolvedActor> {
    return this.actorContext.resolveActor(req.user!.accountId, req.user!.personId);
  }

  // ── Vendor Catalogues (PRC-004) ───────────────────────────────────

  @Get('procurement/vendor-catalogues')
  @RequirePermission('prc-004:read')
  @ApiOperation({ summary: 'List vendor catalogues, optionally filtered by vendorId.' })
  async listCatalogues(@Req() req: AuthRequest, @Query('vendorId') vendorId?: string) {
    return this.catalogues.list(await this.resolve(req), vendorId);
  }

  @Get('procurement/vendor-catalogues/:id')
  @RequirePermission('prc-004:read')
  @ApiOperation({ summary: 'Get a vendor catalogue with inlined items.' })
  async getCatalogue(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalogues.getById(await this.resolve(req), id);
  }

  @Post('procurement/vendor-catalogues')
  @RequirePermission('prc-004:write')
  @ApiOperation({ summary: 'Create a vendor catalogue.' })
  async createCatalogue(@Req() req: AuthRequest, @Body() body: CreateVendorCatalogueDto) {
    return this.catalogues.create(await this.resolve(req), body);
  }

  @Patch('procurement/vendor-catalogues/:id')
  @RequirePermission('prc-004:write')
  @ApiOperation({ summary: 'Update a vendor catalogue header.' })
  async patchCatalogue(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateVendorCatalogueDto,
  ) {
    return this.catalogues.patch(await this.resolve(req), id, body);
  }

  @Post('procurement/vendor-catalogues/:id/items')
  @RequirePermission('prc-004:write')
  @ApiOperation({ summary: 'Add a line item to a vendor catalogue.' })
  async addCatalogueItem(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateCatalogueItemDto,
  ) {
    return this.catalogues.addItem(await this.resolve(req), id, body);
  }

  @Patch('procurement/catalogue-items/:itemId')
  @RequirePermission('prc-004:write')
  @ApiOperation({ summary: 'Update a catalogue item.' })
  async patchCatalogueItem(
    @Req() req: AuthRequest,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: UpdateCatalogueItemDto,
  ) {
    return this.catalogues.patchItem(await this.resolve(req), itemId, body);
  }

  // ── Contracts (PRC-004) ───────────────────────────────────────────

  @Get('procurement/contracts')
  @RequirePermission('prc-004:read')
  @ApiOperation({ summary: 'List vendor contracts, optionally filtered by status.' })
  async listContracts(@Req() req: AuthRequest, @Query('status') status?: ContractStatus) {
    return this.contracts.list(await this.resolve(req), status);
  }

  @Get('procurement/contracts/:id')
  @RequirePermission('prc-004:read')
  @ApiOperation({ summary: 'Get a contract with inlined amendments.' })
  async getContract(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.contracts.getById(await this.resolve(req), id);
  }

  @Post('procurement/contracts')
  @RequirePermission('prc-004:write')
  @ApiOperation({ summary: 'Create a contract (DRAFT).' })
  async createContract(@Req() req: AuthRequest, @Body() body: CreateContractDto) {
    return this.contracts.create(await this.resolve(req), body);
  }

  @Patch('procurement/contracts/:id')
  @RequirePermission('prc-004:write')
  @ApiOperation({
    summary:
      'Update a contract. Status transitions: DRAFT→ACTIVE/TERMINATED, ACTIVE→EXPIRING/RENEWED/TERMINATED, EXPIRING→RENEWED/TERMINATED/ACTIVE, RENEWED→ACTIVE/EXPIRING/TERMINATED. TERMINATED is terminal.',
  })
  async patchContract(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateContractDto,
  ) {
    return this.contracts.patch(await this.resolve(req), id, body);
  }

  @Post('procurement/contracts/:id/amendments')
  @RequirePermission('prc-004:write')
  @ApiOperation({
    summary:
      'Add a numbered amendment to a contract. value_change is applied to parent total_value atomically; newEndDate replaces parent end_date when set.',
  })
  async addAmendment(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateContractAmendmentDto,
  ) {
    return this.contracts.amend(await this.resolve(req), id, body);
  }

  // ── Spending Analytics (PRC-002:read) ─────────────────────────────

  @Get('procurement/spending-analytics')
  @RequirePermission('prc-002:read')
  @ApiOperation({
    summary:
      'Procurement spending rollup by vendor / category / department. Materialised monthly by ProcurementAnalyticsWorker.',
  })
  async listSpendingAnalytics(
    @Req() req: AuthRequest,
    @Query() filter: SpendingAnalyticsFilterDto,
  ) {
    return this.analytics.list(await this.resolve(req), filter);
  }
}
