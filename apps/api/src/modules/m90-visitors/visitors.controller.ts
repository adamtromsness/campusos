import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { BannedPersonService } from './banned-person.service';
import { MusterService } from './muster.service';
import { PreRegistrationService, RecurringVisitorService, SignInService } from './sign-in.service';
import { SignInSettingsService, VisitorService, VisitorTypeService } from './visitor.service';
import {
  BannedPersonCheckDto,
  BannedPersonCheckResultDto,
  BannedPersonDto,
  BypassSafeguardingDto,
  CreateBannedPersonDto,
  CreateMusterDto,
  CreatePreRegistrationDto,
  CreateRecurringVisitorDto,
  CreateSignInDto,
  CreateVisitorDto,
  CreateVisitorTypeDto,
  MusterDetailDto,
  MusterDto,
  MusterEntryDto,
  MusterSummaryDto,
  PreRegistrationDto,
  PreRegistrationScanDto,
  RecurringVisitorDto,
  SignInDto,
  SignInListQueryDto,
  SignInSettingsDto,
  UpdateBannedPersonDto,
  UpdateMusterEntryDto,
  UpdateRecurringVisitorDto,
  UpdateSignInSettingsDto,
  UpdateVisitorDto,
  UpdateVisitorTypeDto,
  VisitorDetailDto,
  VisitorDto,
  VisitorLookupQueryDto,
  VisitorTypeDto,
} from './dto/visitor.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Visitor Management')
@ApiBearerAuth()
@Controller('visitors')
export class VisitorsController {
  constructor(
    private readonly visitorTypes: VisitorTypeService,
    private readonly visitors: VisitorService,
    private readonly settings: SignInSettingsService,
    private readonly signIns: SignInService,
    private readonly preRegs: PreRegistrationService,
    private readonly recurring: RecurringVisitorService,
    private readonly banned: BannedPersonService,
    private readonly muster: MusterService,
    private readonly actors: ActorContextService,
  ) {}

  private async actor(req: AuthedRequest) {
    return this.actors.resolveActor(req.user!.sub, req.user!.personId);
  }

  // ── Visitor Types ──

  @Get('visitor-types')
  @RequirePermission('saf-002:read')
  @ApiOperation({
    summary:
      'List visitor types for this school. Reception staff and teachers see only active types unless includeInactive=true is supplied by an admin.',
  })
  async listTypes(
    @Query('includeInactive') includeInactive: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<VisitorTypeDto[]> {
    const a = await this.actor(req);
    return this.visitorTypes.list(a, includeInactive === 'true');
  }

  @Post('visitor-types')
  @RequirePermission('saf-002:admin')
  @ApiOperation({
    summary: 'Create a visitor type. UNIQUE(school_id, name) — duplicate names rejected with 409.',
  })
  async createType(
    @Body() dto: CreateVisitorTypeDto,
    @Req() req: AuthedRequest,
  ): Promise<VisitorTypeDto> {
    return this.visitorTypes.create(dto, await this.actor(req));
  }

  @Patch('visitor-types/:id')
  @RequirePermission('saf-002:admin')
  async patchType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVisitorTypeDto,
    @Req() req: AuthedRequest,
  ): Promise<VisitorTypeDto> {
    return this.visitorTypes.patch(id, dto, await this.actor(req));
  }

  // ── Visitors ──
  //
  // Uses /visitors/directory/:id path to avoid collision with the
  // sibling literal routes (banned-persons, muster, settings, ...)
  // that would otherwise be matched by the bare /:id pattern.

  @Get('directory')
  @RequirePermission('saf-002:read')
  async listVisitors(
    @Query('search') search: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<VisitorDto[]> {
    return this.visitors.list(await this.actor(req), search);
  }

  @Get('lookup')
  @RequirePermission('saf-002:write')
  @ApiOperation({
    summary:
      'KIOSK RETURNING-VISITOR LOOKUP — accepts raw email, computes the HMAC blind index, returns the matched visitor (id + name + type for kiosk auto-fill). Never decrypts or returns email_encrypted. Responds 204 No Content semantics via null body when no match.',
  })
  async lookup(@Query() query: VisitorLookupQueryDto): Promise<VisitorDto | null> {
    return this.visitors.lookupByEmail(query.email);
  }

  @Get('directory/:id')
  @RequirePermission('saf-002:write')
  @ApiOperation({
    summary:
      'Visitor detail with decrypted email + phone. Requires saf-002:write — kiosk callers (saf-002:read) get the safer non-decrypting lookup path instead.',
  })
  async getVisitor(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<VisitorDetailDto> {
    return this.visitors.getById(id, await this.actor(req));
  }

  @Post('directory')
  @RequirePermission('saf-002:write')
  async createVisitor(
    @Body() dto: CreateVisitorDto,
    @Req() req: AuthedRequest,
  ): Promise<VisitorDto> {
    return this.visitors.create(dto, await this.actor(req));
  }

  @Patch('directory/:id')
  @RequirePermission('saf-002:write')
  async patchVisitor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVisitorDto,
    @Req() req: AuthedRequest,
  ): Promise<VisitorDto> {
    return this.visitors.patch(id, dto, await this.actor(req));
  }

  // ── Sign-In Settings ──

  @Get('settings')
  @RequirePermission('saf-002:read')
  async getSettings(): Promise<SignInSettingsDto> {
    return this.settings.get();
  }

  @Patch('settings')
  @RequirePermission('saf-002:admin')
  async patchSettings(
    @Body() dto: UpdateSignInSettingsDto,
    @Req() req: AuthedRequest,
  ): Promise<SignInSettingsDto> {
    return this.settings.update(dto, await this.actor(req));
  }

  // ── Sign-Ins ──

  @Post('sign-in')
  @RequirePermission('saf-002:write')
  @ApiOperation({
    summary:
      'KIOSK SIGN-IN KEYSTONE. Step 1: resolve or create vis_visitors via HMAC email lookup. Step 2: banned-person HMAC check on every sign-in (BLOCKED throws 403 with neutral "please see reception staff" — never reveals reason; emits vis.banned_person.detected). Step 3: validate safeguarding policy per visitor type. Step 4: INSERT vis_sign_ins. Step 5: emit vis.visitor.signed_in.',
  })
  async createSignIn(@Body() dto: CreateSignInDto, @Req() req: AuthedRequest): Promise<SignInDto> {
    return this.signIns.create(dto, await this.actor(req));
  }

  @Get('on-site')
  @RequirePermission('saf-002:read')
  @ApiOperation({
    summary:
      'Currently on-site visitors (signed_out_at IS NULL). Walks the partial INDEX vis_si_active_idx — instantaneous query.',
  })
  async listOnSite(): Promise<SignInDto[]> {
    return this.signIns.listOnSite();
  }

  @Get('log')
  @RequirePermission('saf-002:read')
  async listLog(@Query() query: SignInListQueryDto): Promise<SignInDto[]> {
    return this.signIns.list(query);
  }

  @Get('sign-ins/:id')
  @RequirePermission('saf-002:read')
  async getSignIn(@Param('id', ParseUUIDPipe) id: string): Promise<SignInDto> {
    return this.signIns.getById(id);
  }

  @Post('sign-ins/:id/sign-out')
  @RequirePermission('saf-002:write')
  async signOut(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<SignInDto> {
    return this.signIns.signOut(id, await this.actor(req));
  }

  @Patch('sign-ins/:id/bypass')
  @RequirePermission('saf-002:admin')
  @ApiOperation({
    summary:
      'School Admin bypasses the safeguarding check. Requires bypassReason more than 10 characters (DTO + service-side defence-in-depth). Stamps bypass_admin_id + bypass_reason atomically per the multi-column vis_si_bypass_chk lockstep.',
  })
  async bypassSafeguarding(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BypassSafeguardingDto,
    @Req() req: AuthedRequest,
  ): Promise<SignInDto> {
    return this.signIns.bypassSafeguarding(id, dto, await this.actor(req));
  }

  // ── Pre-Registrations ──

  @Get('pre-registrations')
  @RequirePermission('saf-002:read')
  async listPreRegs(): Promise<PreRegistrationDto[]> {
    return this.preRegs.list();
  }

  @Post('pre-register')
  @RequirePermission('saf-002:write')
  async createPreReg(
    @Body() dto: CreatePreRegistrationDto,
    @Req() req: AuthedRequest,
  ): Promise<PreRegistrationDto> {
    return this.preRegs.create(dto, await this.actor(req));
  }

  @Post('pre-register/scan')
  @RequirePermission('saf-002:write')
  @ApiOperation({
    summary:
      'KIOSK QR SCAN. Locks the pre-reg row, validates not-expired + not-used (re-scan returns 410 Gone), stamps used_at, and auto-creates the sign-in via SignInService.createFromPreReg.',
  })
  async scanPreReg(
    @Body() dto: PreRegistrationScanDto,
    @Req() req: AuthedRequest,
  ): Promise<SignInDto> {
    return this.preRegs.scan(dto, await this.actor(req));
  }

  @Delete('pre-registrations/:id')
  @RequirePermission('saf-002:write')
  @HttpCode(204)
  async cancelPreReg(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.preRegs.cancel(id, await this.actor(req));
  }

  // ── Recurring Visitors ──

  @Get('recurring')
  @RequirePermission('saf-002:read')
  async listRecurring(): Promise<RecurringVisitorDto[]> {
    return this.recurring.list();
  }

  @Get('recurring/today')
  @RequirePermission('saf-002:read')
  async listRecurringToday(): Promise<RecurringVisitorDto[]> {
    return this.recurring.listToday();
  }

  @Post('recurring')
  @RequirePermission('saf-002:write')
  async createRecurring(
    @Body() dto: CreateRecurringVisitorDto,
    @Req() req: AuthedRequest,
  ): Promise<RecurringVisitorDto> {
    return this.recurring.create(dto, await this.actor(req));
  }

  @Patch('recurring/:id')
  @RequirePermission('saf-002:write')
  async patchRecurring(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRecurringVisitorDto,
    @Req() req: AuthedRequest,
  ): Promise<RecurringVisitorDto> {
    return this.recurring.patch(id, dto, await this.actor(req));
  }

  // ── Banned Persons ──

  @Get('banned-persons')
  @RequirePermission('safeguarding_ban:read')
  @ApiOperation({
    summary:
      'List banned persons with plaintext name + ban detail. Gated on safeguarding_ban:read (admin-only). Reception staff cannot reach this endpoint — they only see the silent BLOCKED kiosk outcome.',
  })
  async listBanned(
    @Query('includeInactive') includeInactive: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<BannedPersonDto[]> {
    return this.banned.list(await this.actor(req), includeInactive === 'true');
  }

  @Get('banned-persons/:id')
  @RequirePermission('safeguarding_ban:read')
  async getBanned(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<BannedPersonDto> {
    return this.banned.getById(id, await this.actor(req));
  }

  @Post('banned-persons')
  @RequirePermission('safeguarding_ban:read')
  async createBanned(
    @Body() dto: CreateBannedPersonDto,
    @Req() req: AuthedRequest,
  ): Promise<BannedPersonDto> {
    return this.banned.create(dto, await this.actor(req));
  }

  @Patch('banned-persons/:id')
  @RequirePermission('safeguarding_ban:read')
  async patchBanned(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBannedPersonDto,
    @Req() req: AuthedRequest,
  ): Promise<BannedPersonDto> {
    return this.banned.patch(id, dto, await this.actor(req));
  }

  @Post('banned-persons/check')
  @RequirePermission('safeguarding_ban:read')
  @ApiOperation({
    summary:
      'ADMIN ORACLE TEST — explicit banned-person screening. REVIEW-P2C1 MAJOR 4: re-gated to safeguarding_ban:read (admin-only) so reception staff cannot probe the registry as a Boolean oracle. The canonical kiosk path is the implicit check inside POST /sign-in, which throws a neutral 403 with no body field that reveals match/no-match. This endpoint stays available to safeguarding admins for testing the registry directly + auditing alerts.',
  })
  async checkBanned(
    @Body() dto: BannedPersonCheckDto,
    @Req() req: AuthedRequest,
  ): Promise<BannedPersonCheckResultDto> {
    return this.banned.checkAtKiosk(dto, await this.actor(req));
  }

  // ── Emergency Muster ──

  @Get('muster')
  @RequirePermission('saf-002:read')
  async listMusters(): Promise<MusterDto[]> {
    return this.muster.list();
  }

  @Get('muster/active')
  @RequirePermission('saf-002:read')
  async getActiveMuster(): Promise<MusterDto | null> {
    return this.muster.getActive();
  }

  @Post('muster')
  @RequirePermission('saf-002:write')
  @ApiOperation({
    summary:
      'EMERGENCY SNAPSHOT KEYSTONE. Walks the partial INDEX vis_si_active_idx and batch-INSERTs vis_muster_entries for everyone currently signed-in. visitor_name + visitor_type + visitor_company are SNAPSHOT fields frozen at creation. Emits vis.muster.created.',
  })
  async createMuster(
    @Body() dto: CreateMusterDto,
    @Req() req: AuthedRequest,
  ): Promise<MusterDetailDto> {
    return this.muster.create(dto, await this.actor(req));
  }

  @Get('muster/:id')
  @RequirePermission('saf-002:read')
  async getMuster(@Param('id', ParseUUIDPipe) id: string): Promise<MusterDetailDto> {
    return this.muster.getDetail(id);
  }

  @Get('muster/:id/summary')
  @RequirePermission('saf-002:read')
  async getMusterSummary(@Param('id', ParseUUIDPipe) id: string): Promise<MusterSummaryDto> {
    return this.muster.getSummary(id);
  }

  @Patch('muster-entries/:id')
  @RequirePermission('saf-002:write')
  async updateMusterEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMusterEntryDto,
    @Req() req: AuthedRequest,
  ): Promise<MusterEntryDto> {
    return this.muster.updateEntry(id, dto, await this.actor(req));
  }

  @Post('muster/:id/close')
  @RequirePermission('saf-002:write')
  async closeMuster(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<MusterDto> {
    return this.muster.close(id, await this.actor(req));
  }
}
