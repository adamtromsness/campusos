import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { DailyMenuService, MenuCycleService, MenuItemService } from './menu.service';
import {
  PosService,
  ReconciliationService,
  SessionService,
  TransactionService,
} from './pos.service';
import {
  AllergenAlertService,
  DietaryProfileService,
  DietaryUpdateRequestService,
  EligibilityService,
  ProductionRecordService,
  TemperatureLogService,
} from './dietary-eligibility.service';
import {
  AddDailyMenuItemDto,
  AllergenAlertResponseDto,
  AllergenCheckResponseDto,
  CreateDailyMenuDto,
  CreateDietaryUpdateRequestDto,
  CreateEligibilityApplicationDto,
  CreateMenuCycleDto,
  CreateMenuItemDto,
  CreatePosDeviceDto,
  CreateProductionRecordDto,
  CreateTemperatureLogDto,
  CreateTransactionDto,
  DailyMenuResponseDto,
  DetermineEligibilityDto,
  DietaryProfileResponseDto,
  DietaryUpdateRequestResponseDto,
  DietaryUpdateStatus,
  EligibilityApplicationResponseDto,
  EligibilityStatus,
  GenerateFromCycleDto,
  GenerateUsdaClaimDto,
  MealType,
  MenuCycleResponseDto,
  MenuItemCategory,
  MenuItemResponseDto,
  OpenSessionDto,
  PosDeviceResponseDto,
  ProductionRecordResponseDto,
  ReconciliationResponseDto,
  ReviewDietaryUpdateDto,
  SessionResponseDto,
  TempCheckLocation,
  TemperatureLogResponseDto,
  TransactionResponseDto,
  UpdateDietaryProfileDto,
  UpdateMenuCycleDto,
  UpdateMenuItemDto,
  UpdatePosDeviceDto,
  UpdateReconciliationDto,
  UsdaClaimResponseDto,
} from './dto/food-service.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Food Service')
@Controller()
export class FoodServiceController {
  constructor(
    private readonly cycles: MenuCycleService,
    private readonly items: MenuItemService,
    private readonly daily: DailyMenuService,
    private readonly pos: PosService,
    private readonly sessions: SessionService,
    private readonly txns: TransactionService,
    private readonly recon: ReconciliationService,
    private readonly profiles: DietaryProfileService,
    private readonly dietaryUpdates: DietaryUpdateRequestService,
    private readonly alerts: AllergenAlertService,
    private readonly eligibility: EligibilityService,
    private readonly tempLogs: TemperatureLogService,
    private readonly production: ProductionRecordService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Menu cycles ──

  @Get('food-service/menu-cycles')
  @RequirePermission('fds-001:read')
  async listCycles(): Promise<MenuCycleResponseDto[]> {
    return this.cycles.list();
  }

  @Post('food-service/menu-cycles')
  @RequirePermission('fds-001:write')
  async createCycle(
    @Body() body: CreateMenuCycleDto,
    @Req() req: AuthedRequest,
  ): Promise<MenuCycleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.cycles.create(body, actor);
  }

  @Patch('food-service/menu-cycles/:id')
  @RequirePermission('fds-001:write')
  async patchCycle(
    @Param('id') id: string,
    @Body() body: UpdateMenuCycleDto,
    @Req() req: AuthedRequest,
  ): Promise<MenuCycleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.cycles.patch(id, body, actor);
  }

  // ── Menu items ──

  @Get('food-service/menu-items')
  @RequirePermission('fds-001:read')
  async listItems(
    @Query('category') category?: string,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<MenuItemResponseDto[]> {
    return this.items.list({
      category: (category as MenuItemCategory) || undefined,
      includeInactive: includeInactive === 'true',
    });
  }

  @Get('food-service/menu-items/allergen-check')
  @RequirePermission('fds-001:read')
  @ApiOperation({ summary: 'Items containing any of the supplied allergen codes' })
  async itemsAllergenCheck(@Query('codes') codes?: string): Promise<MenuItemResponseDto[]> {
    const list = (codes ?? '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    return this.items.allergenCheck(list);
  }

  @Get('food-service/menu-items/:id')
  @RequirePermission('fds-001:read')
  async getItem(@Param('id') id: string): Promise<MenuItemResponseDto> {
    return this.items.getById(id);
  }

  @Post('food-service/menu-items')
  @RequirePermission('fds-001:write')
  async createItem(
    @Body() body: CreateMenuItemDto,
    @Req() req: AuthedRequest,
  ): Promise<MenuItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.items.create(body, actor);
  }

  @Patch('food-service/menu-items/:id')
  @RequirePermission('fds-001:write')
  async patchItem(
    @Param('id') id: string,
    @Body() body: UpdateMenuItemDto,
    @Req() req: AuthedRequest,
  ): Promise<MenuItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.items.patch(id, body, actor);
  }

  // ── Daily menus ──

  @Get('food-service/daily-menus')
  @RequirePermission('fds-001:read')
  async listDailyMenus(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
  ): Promise<DailyMenuResponseDto[]> {
    return this.daily.listByDateRange(fromDate, toDate);
  }

  @Get('food-service/daily-menus/:date/:mealType')
  @RequirePermission('fds-001:read')
  async getDailyMenu(
    @Param('date') date: string,
    @Param('mealType') mealType: string,
  ): Promise<DailyMenuResponseDto | null> {
    return this.daily.getByDate(date, mealType as MealType);
  }

  @Post('food-service/daily-menus')
  @RequirePermission('fds-001:write')
  async createDailyMenu(
    @Body() body: CreateDailyMenuDto,
    @Req() req: AuthedRequest,
  ): Promise<DailyMenuResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.daily.create(body, actor);
  }

  @Post('food-service/daily-menus/:id/items')
  @RequirePermission('fds-001:write')
  async addDailyMenuItem(
    @Param('id') id: string,
    @Body() body: AddDailyMenuItemDto,
    @Req() req: AuthedRequest,
  ) {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.daily.addItem(id, body, actor);
  }

  @Post('food-service/daily-menus/generate-from-cycle')
  @RequirePermission('fds-001:write')
  async generateFromCycle(
    @Body() body: GenerateFromCycleDto,
    @Req() req: AuthedRequest,
  ): Promise<{ created: number; skipped: number }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.daily.generateFromCycle(body, actor);
  }

  // ── POS devices ──

  @Get('food-service/pos-devices')
  @RequirePermission('fds-002:read')
  async listPos(): Promise<PosDeviceResponseDto[]> {
    return this.pos.list();
  }

  @Post('food-service/pos-devices')
  @RequirePermission('fds-002:write')
  async createPos(
    @Body() body: CreatePosDeviceDto,
    @Req() req: AuthedRequest,
  ): Promise<PosDeviceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.pos.create(body, actor);
  }

  @Patch('food-service/pos-devices/:id')
  @RequirePermission('fds-002:write')
  async patchPos(
    @Param('id') id: string,
    @Body() body: UpdatePosDeviceDto,
    @Req() req: AuthedRequest,
  ): Promise<PosDeviceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.pos.patch(id, body, actor);
  }

  // ── Sessions ──

  @Get('food-service/sessions')
  @RequirePermission('fds-002:read')
  async listSessions(
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<SessionResponseDto[]> {
    return this.sessions.list({ fromDate, toDate });
  }

  @Get('food-service/sessions/:id')
  @RequirePermission('fds-002:read')
  async getSession(@Param('id') id: string): Promise<SessionResponseDto> {
    return this.sessions.getById(id);
  }

  @Post('food-service/sessions/open')
  @RequirePermission('fds-002:write')
  async openSession(
    @Body() body: OpenSessionDto,
    @Req() req: AuthedRequest,
  ): Promise<SessionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.open(body, actor);
  }

  @Patch('food-service/sessions/:id/close')
  @RequirePermission('fds-002:write')
  async closeSession(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<SessionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.close(id, actor);
  }

  // ── Transactions (allergen keystone) ──

  @Post('food-service/transactions')
  @RequirePermission('fds-002:write')
  async createTransaction(
    @Body() body: CreateTransactionDto,
    @Req() req: AuthedRequest,
  ): Promise<TransactionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.txns.create(body, actor);
  }

  @Get('food-service/transactions')
  @RequirePermission('fds-002:read')
  async listTransactions(
    @Query('sessionId') sessionId?: string,
    @Query('patronId') patronId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<TransactionResponseDto[]> {
    return this.txns.list({ sessionId, patronId, fromDate, toDate });
  }

  @Get('food-service/patron/:patronId/check-allergens')
  @RequirePermission('fds-002:read')
  async checkAllergens(@Param('patronId') patronId: string): Promise<AllergenCheckResponseDto> {
    return this.txns.checkAllergens(patronId);
  }

  // ── Reconciliation ──

  @Get('food-service/reconciliation/:sessionId')
  @RequirePermission('fds-002:read')
  async getReconciliation(
    @Param('sessionId') sessionId: string,
  ): Promise<ReconciliationResponseDto[]> {
    return this.recon.getBySession(sessionId);
  }

  @Patch('food-service/reconciliation/:id')
  @RequirePermission('fds-002:write')
  async patchReconciliation(
    @Param('id') id: string,
    @Body() body: UpdateReconciliationDto,
    @Req() req: AuthedRequest,
  ): Promise<ReconciliationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recon.patch(id, body, actor);
  }

  // ── Dietary profiles ──

  @Get('food-service/dietary-profiles/:studentId')
  @RequirePermission('fds-003:read')
  async getDietaryProfile(
    @Param('studentId') studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<DietaryProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.profiles.getByStudent(studentId, actor);
  }

  @Patch('food-service/dietary-profiles/:studentId')
  @RequirePermission('fds-003:write')
  async patchDietaryProfile(
    @Param('studentId') studentId: string,
    @Body() body: UpdateDietaryProfileDto,
    @Req() req: AuthedRequest,
  ): Promise<DietaryProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.profiles.patch(studentId, body, actor);
  }

  @Get('food-service/dietary-update-requests')
  @RequirePermission('fds-003:read')
  async listDietaryUpdateRequests(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
  ): Promise<DietaryUpdateRequestResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.dietaryUpdates.list(actor, {
      status: (status as DietaryUpdateStatus) || undefined,
    });
  }

  @Post('food-service/dietary-update-requests')
  @RequirePermission('fds-003:read')
  @ApiOperation({
    summary: 'Parents submit dietary update requests; service-layer row scope is the gate.',
  })
  async submitDietaryUpdate(
    @Body() body: CreateDietaryUpdateRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<DietaryUpdateRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.dietaryUpdates.submit(body, actor);
  }

  @Patch('food-service/dietary-update-requests/:id')
  @RequirePermission('fds-003:write')
  async reviewDietaryUpdate(
    @Param('id') id: string,
    @Body() body: ReviewDietaryUpdateDto,
    @Req() req: AuthedRequest,
  ): Promise<DietaryUpdateRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.dietaryUpdates.review(id, body, actor);
  }

  // ── Allergen alerts ──

  @Get('food-service/allergen-alerts/:studentId')
  @RequirePermission('fds-003:read')
  async listStudentAllergenAlerts(
    @Param('studentId') studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<AllergenAlertResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.listForStudent(studentId, actor);
  }

  @Get('food-service/allergen-alerts')
  @RequirePermission('fds-003:read')
  async listAllergenAlerts(@Req() req: AuthedRequest): Promise<AllergenAlertResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.listAll(actor);
  }

  @Post('food-service/allergen-alerts/sync')
  @RequirePermission('fds-003:admin')
  @ApiOperation({
    summary:
      'Manual sync from hlth_health_alerts. Phase 2 Kafka consumer on hlth.allergy_alert.changed will replace this admin-triggered path.',
  })
  async syncAllergenAlerts(@Req() req: AuthedRequest): Promise<{ synced: number }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alerts.syncFromHealth(actor);
  }

  // ── Eligibility ──

  @Get('food-service/eligibility-applications')
  @RequirePermission('fds-003:read')
  async listEligibilityApplications(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('academicYearId') academicYearId?: string,
  ): Promise<EligibilityApplicationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.eligibility.list(
      {
        status: (status as EligibilityStatus) || undefined,
        academicYearId,
      },
      actor,
    );
  }

  @Post('food-service/eligibility-applications')
  @RequirePermission('fds-003:read')
  async submitEligibilityApplication(
    @Body() body: CreateEligibilityApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<EligibilityApplicationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.eligibility.submit(body, actor);
  }

  @Patch('food-service/eligibility-applications/:id/determine')
  @RequirePermission('fds-003:write')
  async determineEligibility(
    @Param('id') id: string,
    @Body() body: DetermineEligibilityDto,
    @Req() req: AuthedRequest,
  ): Promise<EligibilityApplicationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.eligibility.determine(id, body, actor);
  }

  @Get('food-service/usda-claims')
  @RequirePermission('fds-004:read')
  async listUsdaClaims(): Promise<UsdaClaimResponseDto[]> {
    return this.eligibility.listClaims();
  }

  @Post('food-service/usda-claims')
  @RequirePermission('fds-004:admin')
  async generateUsdaClaim(
    @Body() body: GenerateUsdaClaimDto,
    @Req() req: AuthedRequest,
  ): Promise<UsdaClaimResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.eligibility.generateClaim(body, actor);
  }

  // ── Temperature logs ──

  @Get('food-service/temperature-logs')
  @RequirePermission('fds-004:read')
  async listTempLogs(
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('location') location?: string,
  ): Promise<TemperatureLogResponseDto[]> {
    return this.tempLogs.list({
      fromDate,
      toDate,
      location: (location as TempCheckLocation) || undefined,
    });
  }

  @Get('food-service/temperature-logs/non-compliant')
  @RequirePermission('fds-004:read')
  async listNonCompliantTempLogs(): Promise<TemperatureLogResponseDto[]> {
    return this.tempLogs.list({ onlyNonCompliant: true });
  }

  @Post('food-service/temperature-logs')
  @RequirePermission('fds-004:write')
  async createTempLog(
    @Body() body: CreateTemperatureLogDto,
    @Req() req: AuthedRequest,
  ): Promise<TemperatureLogResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tempLogs.create(body, actor);
  }

  // ── Production records ──

  @Get('food-service/production-records')
  @RequirePermission('fds-004:read')
  async listProductionRecords(
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('mealType') mealType?: string,
  ): Promise<ProductionRecordResponseDto[]> {
    return this.production.list({
      fromDate,
      toDate,
      mealType: (mealType as MealType) || undefined,
    });
  }

  @Post('food-service/production-records')
  @RequirePermission('fds-004:write')
  async createProductionRecord(
    @Body() body: CreateProductionRecordDto,
    @Req() req: AuthedRequest,
  ): Promise<ProductionRecordResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.production.create(body, actor);
  }
}
