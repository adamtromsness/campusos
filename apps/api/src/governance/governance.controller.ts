import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { HomeRegionRequired } from '../region/home-region-required.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { RopaService } from './ropa.service';
import { DpiaService } from './dpia.service';
import { ProcessorService } from './processors.service';
import { BreachService } from './breach.service';
import { SarService } from './sar.service';
import {
  ConsentService,
  ComplianceConfigService,
  ErasureService,
  PrivacyNoticeService,
} from './erasure.service';
import {
  ComplianceDashboardDto,
  CreateBreachDto,
  CreateConsentDto,
  CreateDpaDto,
  CreateDpiaDto,
  CreateErasureDto,
  CreatePrivacyNoticeDto,
  CreateProcessingActivityDto,
  CreateProcessorDto,
  CreateRetentionPolicyDto,
  CreateSarDto,
  NotifyDataSubjectsDto,
  NotifySupervisoryAuthorityDto,
  PseudonymiseAuditDto,
  PublishPrivacyNoticeDto,
  ResolveBreachDto,
  UpdateBreachDto,
  UpdateComplianceConfigDto,
  UpdateDpaDto,
  UpdateDpiaDto,
  UpdateErasureDto,
  UpdateProcessingActivityDto,
  UpdateProcessorDto,
  UpdateRetentionPolicyDto,
  UpdateSarDto,
  WithdrawConsentDto,
} from './dto/governance.dto';

interface AuthedRequest extends Request {
  user: { sub: string; personId: string };
}

@ApiTags('Data Governance & Compliance')
@Controller()
// Cycle 32 Step 6 — DPO operations (SAR, erasure, breach, ROPA,
// consents) MUST run in the tenant's home region per GDPR data
// residency. The RegionMismatchInterceptor returns HTTP 421 if
// process.env.AWS_REGION doesn't match the tenant's home_region.
// Local dev / test (AWS_REGION unset) skips the gate.
@HomeRegionRequired()
export class GovernanceController {
  constructor(
    private readonly actors: ActorContextService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ropa: RopaService,
    private readonly dpias: DpiaService,
    private readonly processors: ProcessorService,
    private readonly breaches: BreachService,
    private readonly sars: SarService,
    private readonly erasures: ErasureService,
    private readonly consents: ConsentService,
    private readonly notices: PrivacyNoticeService,
    private readonly config: ComplianceConfigService,
  ) {}

  // ─── ROPA ─────────────────────────────────────────────────────────

  @Get('governance/processing-activities')
  @RequirePermission('dpo-001:read')
  @ApiOperation({
    summary: 'List ROPA entries (DPO scope only). gapsOnly=true filters to high_risk without DPIA.',
  })
  async listProcessingActivities(
    @Req() req: AuthedRequest,
    @Query('includeInactive') includeInactive?: string,
    @Query('gapsOnly') gapsOnly?: string,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.ropa.listProcessingActivities(actor, {
      includeInactive: includeInactive === 'true',
      gapsOnly: gapsOnly === 'true',
    });
  }

  @Get('governance/processing-activities/:id')
  @RequirePermission('dpo-001:read')
  async getProcessingActivity(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.ropa.getProcessingActivity(actor, id);
  }

  @Post('governance/processing-activities')
  @RequirePermission('dpo-001:write')
  async createProcessingActivity(
    @Req() req: AuthedRequest,
    @Body() body: CreateProcessingActivityDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.ropa.createProcessingActivity(actor, body);
  }

  @Patch('governance/processing-activities/:id')
  @RequirePermission('dpo-001:write')
  async updateProcessingActivity(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateProcessingActivityDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.ropa.updateProcessingActivity(actor, id, body);
  }

  @Delete('governance/processing-activities/:id')
  @RequirePermission('dpo-001:admin')
  @HttpCode(204)
  async deleteProcessingActivity(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    await this.ropa.deleteProcessingActivity(actor, id);
  }

  // ─── Retention ────────────────────────────────────────────────────

  @Get('governance/retention-policies')
  @RequirePermission('dpo-001:read')
  async listRetentionPolicies(@Req() req: AuthedRequest, @Query('dueOnly') dueOnly?: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.ropa.listRetentionPolicies(actor, { dueOnly: dueOnly === 'true' });
  }

  @Get('governance/retention-policies/:id')
  @RequirePermission('dpo-001:read')
  async getRetentionPolicy(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.ropa.getRetentionPolicy(actor, id);
  }

  @Post('governance/retention-policies')
  @RequirePermission('dpo-001:write')
  async createRetentionPolicy(@Req() req: AuthedRequest, @Body() body: CreateRetentionPolicyDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.ropa.createRetentionPolicy(actor, body);
  }

  @Patch('governance/retention-policies/:id')
  @RequirePermission('dpo-001:write')
  async updateRetentionPolicy(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateRetentionPolicyDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.ropa.updateRetentionPolicy(actor, id, body);
  }

  @Delete('governance/retention-policies/:id')
  @RequirePermission('dpo-001:admin')
  @HttpCode(204)
  async deleteRetentionPolicy(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    await this.ropa.deleteRetentionPolicy(actor, id);
  }

  // ─── DPIAs ────────────────────────────────────────────────────────

  @Get('governance/dpias')
  @RequirePermission('dpo-001:read')
  async listDpias(@Req() req: AuthedRequest, @Query('status') status?: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dpias.list(actor, { status });
  }

  @Get('governance/dpias/:id')
  @RequirePermission('dpo-001:read')
  async getDpia(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dpias.getById(actor, id);
  }

  @Post('governance/dpias')
  @RequirePermission('dpo-001:write')
  async createDpia(@Req() req: AuthedRequest, @Body() body: CreateDpiaDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dpias.create(actor, body);
  }

  @Patch('governance/dpias/:id')
  @RequirePermission('dpo-001:write')
  async updateDpia(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateDpiaDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dpias.update(actor, id, body);
  }

  // ─── Processors + DPAs ────────────────────────────────────────────

  @Get('governance/processors')
  @RequirePermission('dpo-002:read')
  async listProcessors(@Req() req: AuthedRequest, @Query('gapsOnly') gapsOnly?: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.processors.listProcessors(actor, { gapsOnly: gapsOnly === 'true' });
  }

  @Get('governance/processors/:id')
  @RequirePermission('dpo-002:read')
  async getProcessor(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.processors.getProcessor(actor, id);
  }

  @Post('governance/processors')
  @RequirePermission('dpo-002:write')
  async createProcessor(@Req() req: AuthedRequest, @Body() body: CreateProcessorDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.processors.createProcessor(actor, body);
  }

  @Patch('governance/processors/:id')
  @RequirePermission('dpo-002:write')
  async updateProcessor(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateProcessorDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.processors.updateProcessor(actor, id, body);
  }

  @Get('governance/dpas')
  @RequirePermission('dpo-002:read')
  async listDpas(@Req() req: AuthedRequest, @Query('processorId') processorId?: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.processors.listDpas(actor, processorId);
  }

  @Get('governance/dpas/:id')
  @RequirePermission('dpo-002:read')
  async getDpa(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.processors.getDpa(actor, id);
  }

  @Post('governance/dpas')
  @RequirePermission('dpo-002:write')
  async createDpa(@Req() req: AuthedRequest, @Body() body: CreateDpaDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.processors.createDpa(actor, body);
  }

  @Patch('governance/dpas/:id')
  @RequirePermission('dpo-002:write')
  async updateDpa(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: UpdateDpaDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.processors.updateDpa(actor, id, body);
  }

  // ─── Breaches ─────────────────────────────────────────────────────

  @Get('governance/breaches')
  @RequirePermission('dpo-003:read')
  async listBreaches(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('pendingNotificationOnly') pending?: string,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.breaches.list(actor, {
      status,
      pendingNotificationOnly: pending === 'true',
    });
  }

  @Get('governance/breaches/:id')
  @RequirePermission('dpo-003:read')
  async getBreach(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.breaches.getById(actor, id);
  }

  @Post('governance/breaches')
  @RequirePermission('dpo-003:write')
  @ApiOperation({
    summary:
      '72-hour countdown keystone — emits dpo.breach.discovered AFTER tx commits when supervisoryAuthorityNotificationRequired=true. Cycle 7 TaskWorker creates URGENT 72h escalating task.',
  })
  async createBreach(@Req() req: AuthedRequest, @Body() body: CreateBreachDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.breaches.create(actor, body);
  }

  @Patch('governance/breaches/:id')
  @RequirePermission('dpo-003:write')
  async updateBreach(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateBreachDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.breaches.update(actor, id, body);
  }

  @Patch('governance/breaches/:id/notify-supervisory-authority')
  @RequirePermission('dpo-003:write')
  async notifySa(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: NotifySupervisoryAuthorityDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.breaches.notifySupervisoryAuthority(actor, id, body);
  }

  @Patch('governance/breaches/:id/notify-data-subjects')
  @RequirePermission('dpo-003:write')
  async notifyDs(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: NotifyDataSubjectsDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.breaches.notifyDataSubjects(actor, id, body);
  }

  @Patch('governance/breaches/:id/resolve')
  @RequirePermission('dpo-003:write')
  async resolveBreach(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ResolveBreachDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.breaches.resolve(actor, id, body);
  }

  // ─── SARs ─────────────────────────────────────────────────────────

  @Get('governance/sars')
  @RequirePermission('dpo-004:read')
  async listSars(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('overdueOnly') overdueOnly?: string,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.sars.list(actor, { status, overdueOnly: overdueOnly === 'true' });
  }

  @Get('governance/sars/:id')
  @RequirePermission('dpo-004:read')
  async getSar(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.sars.getById(actor, id);
  }

  @Post('governance/sars')
  @RequirePermission('dpo-004:read', 'dpo-004:write')
  @ApiOperation({
    summary:
      'Submit a SAR. GUARDIAN/STUDENT can self-serve via dpo-004:read+write; DPO can submit on behalf via dpo-004:write. Age-18 keystone — guardian path is refused when platform_students.data_subject_is_self=true.',
  })
  async createSar(@Req() req: AuthedRequest, @Body() body: CreateSarDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.sars.create(actor, body);
  }

  @Patch('governance/sars/:id')
  @RequirePermission('dpo-004:write')
  async updateSar(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: UpdateSarDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.sars.update(actor, id, body);
  }

  // ─── Erasure ──────────────────────────────────────────────────────

  @Get('governance/erasures')
  @RequirePermission('dpo-004:write')
  async listErasures(@Req() req: AuthedRequest, @Query('status') status?: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.erasures.list(actor, { status });
  }

  @Get('governance/erasures/:id')
  @RequirePermission('dpo-004:write')
  async getErasure(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.erasures.getById(actor, id);
  }

  @Post('governance/erasures')
  @RequirePermission('dpo-004:write')
  async createErasure(@Req() req: AuthedRequest, @Body() body: CreateErasureDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.erasures.create(actor, body);
  }

  @Patch('governance/erasures/:id')
  @RequirePermission('dpo-004:write')
  async updateErasure(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateErasureDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.erasures.update(actor, id, body);
  }

  @Post('governance/erasures/:id/pseudonymise')
  @RequirePermission('dpo-004:write')
  @ApiOperation({
    summary:
      'Audit log pseudonymisation keystone. Rewrites platform_audit_log.metadata for the data subject and writes one IMMUTABLE dpo_pseudonymisation_log row.',
  })
  async pseudonymise(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: PseudonymiseAuditDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.erasures.pseudonymiseAuditLog(actor, id, body);
  }

  @Get('governance/pseudonymisation-log')
  @RequirePermission('dpo-004:write')
  async listPseudonymisations(
    @Req() req: AuthedRequest,
    @Query('erasureRequestId') erasureRequestId?: string,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.erasures.listPseudonymisations(actor, erasureRequestId);
  }

  // ─── Consent ──────────────────────────────────────────────────────

  @Get('governance/consents')
  @RequirePermission('dpo-005:read')
  async listConsents(
    @Req() req: AuthedRequest,
    @Query('dataSubjectId') dataSubjectId?: string,
    @Query('processingActivityId') processingActivityId?: string,
    @Query('consentedOnly') consentedOnly?: string,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.consents.list(actor, {
      dataSubjectId,
      processingActivityId,
      consentedOnly: consentedOnly === 'true',
    });
  }

  @Post('governance/consents')
  @RequirePermission('dpo-005:write')
  async createConsent(@Req() req: AuthedRequest, @Body() body: CreateConsentDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.consents.create(actor, body);
  }

  @Patch('governance/consents/:id/withdraw')
  @RequirePermission('dpo-005:write')
  async withdrawConsent(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: WithdrawConsentDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.consents.withdraw(actor, id, body);
  }

  // ─── Privacy Notices ──────────────────────────────────────────────

  @Get('governance/privacy-notices')
  @RequirePermission('dpo-005:read')
  async listNotices(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.notices.list(actor);
  }

  @Get('governance/privacy-notices/current')
  @RequirePermission('dpo-005:read')
  async currentNotice(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    const current = await this.notices.getCurrent(actor);
    return current ?? { current: null };
  }

  @Post('governance/privacy-notices')
  @RequirePermission('dpo-005:write')
  async createNotice(@Req() req: AuthedRequest, @Body() body: CreatePrivacyNoticeDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.notices.create(actor, body);
  }

  @Patch('governance/privacy-notices/:id/publish')
  @RequirePermission('dpo-005:write')
  async publishNotice(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: PublishPrivacyNoticeDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.notices.publish(actor, id, body);
  }

  // ─── Compliance Config ────────────────────────────────────────────

  @Get('governance/compliance-config')
  @RequirePermission('dpo-001:read')
  async getConfig(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.config.get(actor);
  }

  @Patch('governance/compliance-config')
  @RequirePermission('dpo-001:admin')
  async updateConfig(@Req() req: AuthedRequest, @Body() body: UpdateComplianceConfigDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.config.update(actor, body);
  }

  // ─── Dashboard rollup ─────────────────────────────────────────────

  @Get('governance/dashboard')
  @RequirePermission('dpo-001:read')
  @ApiOperation({
    summary:
      'Compliance dashboard rollup — DPIA gaps + DPA gaps + breach countdown + SAR pipeline.',
  })
  async dashboard(@Req() req: AuthedRequest): Promise<ComplianceDashboardDto> {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    void actor;
    const tenant = getCurrentTenant();
    const counts = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT
           (SELECT count(*) FROM dpo_processing_activities WHERE school_id = $1::uuid AND is_active = true) AS ropa,
           (SELECT count(*) FROM dpo_processing_activities WHERE school_id = $1::uuid AND is_active = true AND high_risk_processing = true) AS high_risk,
           (SELECT count(*) FROM dpo_processing_activities WHERE school_id = $1::uuid AND is_active = true AND high_risk_processing = true AND dpia_id IS NULL) AS dpia_gaps,
           (SELECT count(*) FROM dpo_retention_policies WHERE school_id = $1::uuid) AS retention,
           (SELECT count(*) FROM dpo_retention_policies WHERE school_id = $1::uuid AND next_review_date <= CURRENT_DATE + INTERVAL '30 days') AS retention_due,
           (SELECT count(*) FROM dpo_third_party_processors WHERE school_id = $1::uuid) AS processors,
           (SELECT count(*) FROM dpo_third_party_processors WHERE school_id = $1::uuid AND dpa_in_place = false) AS dpa_gaps,
           (SELECT count(*) FROM dpo_data_processing_agreements WHERE school_id = $1::uuid AND review_date <= CURRENT_DATE + INTERVAL '60 days') AS dpa_due,
           (SELECT count(*) FROM dpo_data_breach_records WHERE school_id = $1::uuid AND status <> 'RESOLVED') AS active_breaches,
           (SELECT count(*) FROM dpo_data_breach_records WHERE school_id = $1::uuid AND supervisory_authority_notification_required = true AND supervisory_authority_notified_at IS NULL) AS pending_breach_notify,
           (SELECT count(*) FROM dpo_data_breach_records WHERE school_id = $1::uuid AND supervisory_authority_notification_required = true AND supervisory_authority_notified_at IS NULL AND discovery_date < now() - INTERVAL '72 hours') AS overdue_breach,
           (SELECT count(*) FROM dpo_subject_access_requests WHERE school_id = $1::uuid AND status NOT IN ('COMPLETED','DENIED')) AS pending_sars,
           (SELECT count(*) FROM dpo_subject_access_requests WHERE school_id = $1::uuid AND deadline_date < CURRENT_DATE AND status NOT IN ('COMPLETED','DENIED')) AS overdue_sars,
           (SELECT count(*) FROM dpo_erasure_requests WHERE school_id = $1::uuid AND status NOT IN ('COMPLETED','DENIED')) AS pending_erasures,
           (SELECT count(*) FROM dpo_pseudonymisation_log WHERE school_id = $1::uuid AND pseudonymised_at >= now() - INTERVAL '30 days') AS pseudonymisations,
           (SELECT count(*) FROM dpo_processing_consent_records WHERE school_id = $1::uuid AND consented = true AND consent_withdrawn_at IS NULL) AS active_consents,
           (SELECT count(*) FROM dpo_processing_consent_records WHERE school_id = $1::uuid AND consent_withdrawn_at IS NOT NULL) AS withdrawn_consents,
           (SELECT notice_version FROM dpo_privacy_notices WHERE school_id = $1::uuid AND superseded_at IS NULL AND published_at IS NOT NULL ORDER BY effective_from DESC LIMIT 1) AS current_notice`,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    const r = counts[0]!;
    return {
      schoolId: tenant.schoolId,
      asOf: new Date().toISOString(),
      ropaCount: Number(r.ropa ?? 0),
      highRiskActivities: Number(r.high_risk ?? 0),
      dpiaGaps: Number(r.dpia_gaps ?? 0),
      retentionPolicies: Number(r.retention ?? 0),
      retentionReviewsDue: Number(r.retention_due ?? 0),
      processors: Number(r.processors ?? 0),
      dpaGaps: Number(r.dpa_gaps ?? 0),
      dpaReviewsDue: Number(r.dpa_due ?? 0),
      activeBreaches: Number(r.active_breaches ?? 0),
      breachesAwaitingNotification: Number(r.pending_breach_notify ?? 0),
      breachOverdueCount: Number(r.overdue_breach ?? 0),
      pendingSars: Number(r.pending_sars ?? 0),
      overdueSars: Number(r.overdue_sars ?? 0),
      pendingErasures: Number(r.pending_erasures ?? 0),
      pseudonymisationsLast30Days: Number(r.pseudonymisations ?? 0),
      activeConsents: Number(r.active_consents ?? 0),
      withdrawnConsents: Number(r.withdrawn_consents ?? 0),
      currentPrivacyNoticeVersion: (r.current_notice as string | null) ?? null,
    };
  }
}
