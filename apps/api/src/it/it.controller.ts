import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import {
  AssetCategoryService,
  AssetDocumentService,
  AssetService,
  AssignmentService,
  DamageReportService,
  RepairRecordService,
} from './assets.service';
import { CredentialVaultService, LicenceService } from './licences.service';
import {
  DeviceSelectionService,
  InfrastructureService,
  MdmService,
  ProcurementService,
} from './mdm.service';
import {
  ApproveSelectionDto,
  AssetCategoryDto,
  AssetDocumentDto,
  AssetDto,
  AssetStatus,
  AssignAssetDto,
  AssignLicenceDto,
  AssignmentDto,
  CreateAssetCategoryDto,
  CreateAssetDocumentDto,
  CreateAssetDto,
  CreateCredentialDto,
  CreateDamageReportDto,
  CreateDeviceOptionDto,
  CreateDeviceSelectionDto,
  CreateInfrastructureItemDto,
  CreateLicenceDto,
  CreateMdmAlertDto,
  CreateMdmSyncDto,
  CreateProcurementOrderDto,
  CreateRepairDto,
  CredentialAccessLogDto,
  CredentialDetailDto,
  CredentialSummaryDto,
  DamageReportDto,
  DeviceOptionDto,
  DeviceSelectionDto,
  InfrastructureItemDto,
  LicenceAssignmentDto,
  LicenceDto,
  MarkDeliveredDto,
  MdmAlertDto,
  MdmSyncDto,
  ProcurementOrderDto,
  RepairRecordDto,
  ResolveMdmAlertDto,
  ReturnAssetDto,
  UpdateAssetCategoryDto,
  UpdateAssetDto,
  UpdateCredentialDto,
  UpdateDeviceOptionDto,
  UpdateInfrastructureItemDto,
  UpdateLicenceDto,
  UpdateProcurementOrderDto,
  UpdateRepairDto,
} from './dto/it.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('IT Infrastructure')
@Controller()
export class ItController {
  constructor(
    private readonly categories: AssetCategoryService,
    private readonly assets: AssetService,
    private readonly assignments: AssignmentService,
    private readonly documents: AssetDocumentService,
    private readonly damages: DamageReportService,
    private readonly repairs: RepairRecordService,
    private readonly licences: LicenceService,
    private readonly vault: CredentialVaultService,
    private readonly mdm: MdmService,
    private readonly infra: InfrastructureService,
    private readonly procurement: ProcurementService,
    private readonly selections: DeviceSelectionService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) {
      throw new Error('Unauthenticated request reached IT controller');
    }
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ── Asset Categories ──

  @Get('it/asset-categories')
  @RequirePermission('it-002:read')
  @ApiOperation({ summary: 'List IT asset categories' })
  async listCategories(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<AssetCategoryDto[]> {
    return this.categories.list(includeInactive === 'true');
  }

  @Post('it/asset-categories')
  @RequirePermission('it-002:write')
  async createCategory(
    @Body() dto: CreateAssetCategoryDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetCategoryDto> {
    return this.categories.create(dto, await this.resolveActor(req));
  }

  @Patch('it/asset-categories/:id')
  @RequirePermission('it-002:write')
  async patchCategory(
    @Param('id') id: string,
    @Body() dto: UpdateAssetCategoryDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetCategoryDto> {
    return this.categories.patch(id, dto, await this.resolveActor(req));
  }

  // ── Assets ──

  @Get('it/assets')
  @RequirePermission('it-002:read')
  @ApiOperation({
    summary:
      'List assets — admin/IT staff see everything, students/teachers/parents see only assets currently assigned to them',
  })
  async listAssets(
    @Req() req: AuthedRequest,
    @Query('status') status?: AssetStatus,
    @Query('categoryId') categoryId?: string,
  ): Promise<AssetDto[]> {
    return this.assets.list(await this.resolveActor(req), { status, categoryId });
  }

  @Get('it/assets/:id')
  @RequirePermission('it-002:read')
  async getAsset(@Param('id') id: string, @Req() req: AuthedRequest): Promise<AssetDto> {
    return this.assets.getById(id, await this.resolveActor(req));
  }

  @Post('it/assets')
  @RequirePermission('it-002:write')
  async createAsset(@Body() dto: CreateAssetDto, @Req() req: AuthedRequest): Promise<AssetDto> {
    return this.assets.create(dto, await this.resolveActor(req));
  }

  @Patch('it/assets/:id')
  @RequirePermission('it-002:write')
  async patchAsset(
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetDto> {
    return this.assets.patch(id, dto, await this.resolveActor(req));
  }

  // ── Assignments ──

  @Get('it/assets/:id/assignments')
  @RequirePermission('it-002:read')
  @ApiOperation({
    summary:
      'Asset assignment history — IT staff/admin all; non-staff actors only when the asset is currently assigned to them (REVIEW-CYCLE22 BLOCKING 2)',
  })
  async listAssetAssignments(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentDto[]> {
    return this.assignments.listForAsset(id, await this.resolveActor(req));
  }

  @Get('it/me/assignments')
  @RequirePermission('it-002:read')
  @ApiOperation({ summary: "Caller's currently-assigned assets" })
  async listMyAssignments(@Req() req: AuthedRequest): Promise<AssignmentDto[]> {
    return this.assignments.listForUser(await this.resolveActor(req));
  }

  @Post('it/assets/:id/assign')
  @RequirePermission('it-002:write')
  async assignAsset(
    @Param('id') id: string,
    @Body() dto: AssignAssetDto,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentDto> {
    return this.assignments.assignAsset(id, dto, await this.resolveActor(req));
  }

  @Post('it/assignments/:assignmentId/return')
  @RequirePermission('it-002:write')
  async returnAssignment(
    @Param('assignmentId') assignmentId: string,
    @Body() dto: ReturnAssetDto,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentDto> {
    return this.assignments.returnAssignment(assignmentId, dto, await this.resolveActor(req));
  }

  // ── Documents ──

  @Get('it/assets/:id/documents')
  @RequirePermission('it-002:read')
  @ApiOperation({
    summary:
      'Asset documents — IT staff/admin all; non-staff actors only when the asset is currently assigned to them (REVIEW-CYCLE22 BLOCKING 2)',
  })
  async listDocuments(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AssetDocumentDto[]> {
    return this.documents.listForAsset(id, await this.resolveActor(req));
  }

  @Post('it/assets/:id/documents')
  @RequirePermission('it-002:write')
  async createDocument(
    @Param('id') id: string,
    @Body() dto: CreateAssetDocumentDto,
    @Req() req: AuthedRequest,
  ): Promise<AssetDocumentDto> {
    return this.documents.create(id, dto, await this.resolveActor(req));
  }

  // ── Damage Reports ──

  @Get('it/damage-reports')
  @RequirePermission('it-002:read')
  @ApiOperation({
    summary:
      'Damage reports — IT staff/admin all; non-staff actors only see reports they filed OR reports on their currently-assigned asset (REVIEW-CYCLE22 BLOCKING 2)',
  })
  async listDamage(
    @Req() req: AuthedRequest,
    @Query('assetId') assetId?: string,
  ): Promise<DamageReportDto[]> {
    return this.damages.list({ assetId }, await this.resolveActor(req));
  }

  @Post('it/damage-reports')
  @RequirePermission('it-002:write')
  @ApiOperation({
    summary:
      'File a damage report — IT staff can file for any asset; students/teachers can file for their own currently-assigned device',
  })
  async createDamage(
    @Body() dto: CreateDamageReportDto,
    @Req() req: AuthedRequest,
  ): Promise<DamageReportDto> {
    return this.damages.create(dto, await this.resolveActor(req));
  }

  // ── Repair Records ──

  @Get('it/repairs')
  @RequirePermission('it-002:read')
  @ApiOperation({
    summary:
      'Repair records — IT staff/admin only; non-staff actors receive an empty list (REVIEW-CYCLE22 BLOCKING 2)',
  })
  async listRepairs(
    @Req() req: AuthedRequest,
    @Query('assetId') assetId?: string,
  ): Promise<RepairRecordDto[]> {
    return this.repairs.list({ assetId }, await this.resolveActor(req));
  }

  @Post('it/repairs')
  @RequirePermission('it-002:write')
  async createRepair(
    @Body() dto: CreateRepairDto,
    @Req() req: AuthedRequest,
  ): Promise<RepairRecordDto> {
    return this.repairs.create(dto, await this.resolveActor(req));
  }

  @Patch('it/repairs/:id')
  @RequirePermission('it-002:write')
  async patchRepair(
    @Param('id') id: string,
    @Body() dto: UpdateRepairDto,
    @Req() req: AuthedRequest,
  ): Promise<RepairRecordDto> {
    return this.repairs.patch(id, dto, await this.resolveActor(req));
  }

  // ── Licences ──

  @Get('it/licences')
  @RequirePermission('it-004:read')
  async listLicences(@Query('includeInactive') includeInactive?: string): Promise<LicenceDto[]> {
    return this.licences.list(includeInactive === 'true');
  }

  @Get('it/licences/:id')
  @RequirePermission('it-004:read')
  async getLicence(@Param('id') id: string): Promise<LicenceDto> {
    return this.licences.getById(id);
  }

  @Post('it/licences')
  @RequirePermission('it-004:write')
  async createLicence(
    @Body() dto: CreateLicenceDto,
    @Req() req: AuthedRequest,
  ): Promise<LicenceDto> {
    return this.licences.create(dto, await this.resolveActor(req));
  }

  @Patch('it/licences/:id')
  @RequirePermission('it-004:write')
  async patchLicence(
    @Param('id') id: string,
    @Body() dto: UpdateLicenceDto,
    @Req() req: AuthedRequest,
  ): Promise<LicenceDto> {
    return this.licences.patch(id, dto, await this.resolveActor(req));
  }

  @Get('it/licences/:id/assignments')
  @RequirePermission('it-004:read')
  async listLicenceAssignments(@Param('id') id: string): Promise<LicenceAssignmentDto[]> {
    return this.licences.listAssignments(id);
  }

  @Post('it/licences/:id/assign')
  @RequirePermission('it-004:write')
  @ApiOperation({
    summary:
      'Assign a software licence — checks seat capacity, bumps used_seats, emits tech.licence.near_capacity at >= 80% utilisation',
  })
  async assignLicence(
    @Param('id') id: string,
    @Body() dto: AssignLicenceDto,
    @Req() req: AuthedRequest,
  ): Promise<LicenceAssignmentDto> {
    return this.licences.assignSeat(id, dto, await this.resolveActor(req));
  }

  @Delete('it/licence-assignments/:id')
  @RequirePermission('it-004:write')
  async unassignLicence(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.licences.unassignSeat(id, await this.resolveActor(req));
  }

  // ── Credential Vault (SECURITY KEYSTONE) ──

  @Get('it/vault')
  @RequirePermission('it-005:read')
  @ApiOperation({
    summary:
      'List credential vault summaries (no plaintext password) — IT staff and school admins only; tier check is enforced on getById not list',
  })
  async listVault(@Req() req: AuthedRequest): Promise<CredentialSummaryDto[]> {
    return this.vault.list(await this.resolveActor(req));
  }

  @Get('it/vault/:id')
  @RequirePermission('it-005:read')
  @ApiOperation({
    summary:
      'Decrypt and return a credential — refuses when actor tier < credential tier; writes a VIEW row to tech_credential_access_log inside the same tx',
  })
  async getVault(@Param('id') id: string, @Req() req: AuthedRequest): Promise<CredentialDetailDto> {
    return this.vault.getByIdWithPassword(id, await this.resolveActor(req));
  }

  @Post('it/vault')
  @RequirePermission('it-005:write')
  async createVault(
    @Body() dto: CreateCredentialDto,
    @Req() req: AuthedRequest,
  ): Promise<CredentialSummaryDto> {
    return this.vault.create(dto, await this.resolveActor(req));
  }

  @Patch('it/vault/:id')
  @RequirePermission('it-005:write')
  async patchVault(
    @Param('id') id: string,
    @Body() dto: UpdateCredentialDto,
    @Req() req: AuthedRequest,
  ): Promise<CredentialSummaryDto> {
    return this.vault.patch(id, dto, await this.resolveActor(req));
  }

  @Delete('it/vault/:id')
  @RequirePermission('it-005:admin')
  async deleteVault(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.vault.remove(id, await this.resolveActor(req));
  }

  @Get('it/vault/:id/access-log')
  @RequirePermission('it-005:read')
  async vaultAccessLog(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<CredentialAccessLogDto[]> {
    return this.vault.accessLog(id, await this.resolveActor(req));
  }

  // ── MDM ──

  @Get('it/mdm/syncs')
  @RequirePermission('it-006:read')
  async listMdmSyncs(@Query('assetId') assetId?: string): Promise<MdmSyncDto[]> {
    return this.mdm.listSyncs({ assetId });
  }

  @Post('it/mdm/syncs')
  @RequirePermission('it-006:write')
  async createMdmSync(
    @Body() dto: CreateMdmSyncDto,
    @Req() req: AuthedRequest,
  ): Promise<MdmSyncDto> {
    return this.mdm.createSync(dto, await this.resolveActor(req));
  }

  @Get('it/mdm/alerts')
  @RequirePermission('it-006:read')
  async listMdmAlerts(@Query('unresolved') unresolved?: string): Promise<MdmAlertDto[]> {
    return this.mdm.listAlerts({ unresolved: unresolved !== 'false' });
  }

  @Post('it/mdm/alerts')
  @RequirePermission('it-006:write')
  async createMdmAlert(
    @Body() dto: CreateMdmAlertDto,
    @Req() req: AuthedRequest,
  ): Promise<MdmAlertDto> {
    return this.mdm.createAlert(dto, await this.resolveActor(req));
  }

  @Patch('it/mdm/alerts/:id/resolve')
  @RequirePermission('it-006:write')
  async resolveMdmAlert(
    @Param('id') id: string,
    @Body() dto: ResolveMdmAlertDto,
    @Req() req: AuthedRequest,
  ): Promise<MdmAlertDto> {
    return this.mdm.resolveAlert(id, dto, await this.resolveActor(req));
  }

  // ── Infrastructure ──

  @Get('it/infrastructure')
  @RequirePermission('it-006:read')
  async listInfrastructure(@Query('itemType') itemType?: string): Promise<InfrastructureItemDto[]> {
    return this.infra.list({ itemType });
  }

  @Get('it/infrastructure/:id')
  @RequirePermission('it-006:read')
  async getInfrastructure(@Param('id') id: string): Promise<InfrastructureItemDto> {
    return this.infra.getById(id);
  }

  @Post('it/infrastructure')
  @RequirePermission('it-006:write')
  async createInfrastructure(
    @Body() dto: CreateInfrastructureItemDto,
    @Req() req: AuthedRequest,
  ): Promise<InfrastructureItemDto> {
    return this.infra.create(dto, await this.resolveActor(req));
  }

  @Patch('it/infrastructure/:id')
  @RequirePermission('it-006:write')
  async patchInfrastructure(
    @Param('id') id: string,
    @Body() dto: UpdateInfrastructureItemDto,
    @Req() req: AuthedRequest,
  ): Promise<InfrastructureItemDto> {
    return this.infra.patch(id, dto, await this.resolveActor(req));
  }

  // ── Procurement ──

  @Get('it/procurement')
  @RequirePermission('it-002:read')
  async listProcurement(@Query('status') status?: string): Promise<ProcurementOrderDto[]> {
    return this.procurement.list({ status });
  }

  @Get('it/procurement/:id')
  @RequirePermission('it-002:read')
  async getProcurement(@Param('id') id: string): Promise<ProcurementOrderDto> {
    return this.procurement.getById(id);
  }

  @Post('it/procurement')
  @RequirePermission('it-002:write')
  async createProcurement(
    @Body() dto: CreateProcurementOrderDto,
    @Req() req: AuthedRequest,
  ): Promise<ProcurementOrderDto> {
    return this.procurement.create(dto, await this.resolveActor(req));
  }

  @Patch('it/procurement/:id')
  @RequirePermission('it-002:write')
  async patchProcurement(
    @Param('id') id: string,
    @Body() dto: UpdateProcurementOrderDto,
    @Req() req: AuthedRequest,
  ): Promise<ProcurementOrderDto> {
    return this.procurement.patch(id, dto, await this.resolveActor(req));
  }

  @Patch('it/procurement/:id/deliver')
  @RequirePermission('it-002:write')
  async deliverProcurement(
    @Param('id') id: string,
    @Body() dto: MarkDeliveredDto,
    @Req() req: AuthedRequest,
  ): Promise<ProcurementOrderDto> {
    return this.procurement.markDelivered(id, dto, await this.resolveActor(req));
  }

  // ── Device Selection (ADR-066) ──

  @Get('it/device-options')
  @RequirePermission('it-003:read')
  async listDeviceOptions(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<DeviceOptionDto[]> {
    return this.selections.listOptions(includeInactive === 'true');
  }

  @Post('it/device-options')
  @RequirePermission('it-003:write')
  async createDeviceOption(
    @Body() dto: CreateDeviceOptionDto,
    @Req() req: AuthedRequest,
  ): Promise<DeviceOptionDto> {
    return this.selections.createOption(dto, await this.resolveActor(req));
  }

  @Patch('it/device-options/:id')
  @RequirePermission('it-003:write')
  async patchDeviceOption(
    @Param('id') id: string,
    @Body() dto: UpdateDeviceOptionDto,
    @Req() req: AuthedRequest,
  ): Promise<DeviceOptionDto> {
    return this.selections.patchOption(id, dto, await this.resolveActor(req));
  }

  @Get('it/device-selections')
  @RequirePermission('it-003:read')
  @ApiOperation({
    summary:
      'List device selections — IT staff/admin see all; students see own; guardians see linked children; teachers receive empty list (REVIEW-CYCLE22 BLOCKING 1 row scope)',
  })
  async listSelections(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('personId') personId?: string,
  ): Promise<DeviceSelectionDto[]> {
    return this.selections.listSelections({ status, personId }, await this.resolveActor(req));
  }

  @Post('it/device-selections')
  @RequirePermission('it-003:write')
  @ApiOperation({
    summary:
      'Submit a device selection — students select for themselves, parents select for their own children, IT staff/school admins select on behalf of any person (ADR-066 parent-active onboarding path)',
  })
  async createSelection(
    @Body() dto: CreateDeviceSelectionDto,
    @Req() req: AuthedRequest,
  ): Promise<DeviceSelectionDto> {
    return this.selections.createSelection(dto, await this.resolveActor(req));
  }

  @Patch('it/device-selections/:id/approve')
  @RequirePermission('it-003:write')
  async approveSelection(
    @Param('id') id: string,
    @Body() dto: ApproveSelectionDto,
    @Req() req: AuthedRequest,
  ): Promise<DeviceSelectionDto> {
    return this.selections.approveSelection(id, dto, await this.resolveActor(req));
  }

  @Patch('it/device-selections/:id/reject')
  @RequirePermission('it-003:write')
  async rejectSelection(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<DeviceSelectionDto> {
    return this.selections.rejectSelection(id, await this.resolveActor(req));
  }

  // Suppress unused import shape
  // (CreateLicenceDto / UpdateAssetCategoryDto / UpdateAssetDto / etc. are
  // referenced via the body decorators above. tsc-strict TS6133 only flags
  // imports with no references in the module, so the type-only imports
  // tied to @Body() values are kept on purpose.)
}
