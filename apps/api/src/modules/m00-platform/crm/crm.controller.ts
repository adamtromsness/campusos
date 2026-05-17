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
import { PlatformScoped } from '@shared/auth';
import { RequirePermission } from '@shared/auth';
import {
  CreateAccountDto,
  CreateContactDto,
  CreateHealthScoreDto,
  CreateInteractionDto,
  CreateRenewalDto,
  CreateSubscriptionDto,
  InitOnboardingDto,
  ListAccountsArgs,
  PatchAccountDto,
  PatchContactDto,
  PatchOnboardingTaskDto,
  PatchRenewalDto,
  PatchSubscriptionDto,
  TransitionAccountStatusDto,
  ACCOUNT_STATUSES,
  RENEWAL_STAGES,
  RenewalStage,
} from './dto/crm.dto';
import { AccountService } from './services/account.service';
import { ContactService } from './services/contact.service';
import { HealthScoreService } from './services/health-score.service';
import { OnboardingService } from './services/onboarding.service';
import { RenewalService } from './services/renewal.service';
import { SubscriptionService } from './services/subscription.service';

interface AuthedRequest extends Request {
  user: { sub: string; personId: string };
}

/**
 * P2-21a — CRM Controller.
 *
 * All routes mounted under /api/v1/internal/crm/* and gated as
 * platform-scoped via @PlatformScoped() — no tenant subdomain header
 * required; permission resolution against the PLATFORM IAM scope.
 *
 * Permission tiers (catalogue):
 *   CRM-001 Lead Management         — list/create accounts, MRR overview
 *   CRM-002 School Onboarding       — onboarding checklist + tasks
 *   CRM-003 Subscription Management — subscriptions + Stripe sync
 *   CRM-004 Customer Communications — contacts (CRUD)
 *   CRM-005 Customer Health Scoring — health-score reads + recompute
 *   CRM-006 Customer Interactions   — interaction log
 *
 * Platform Admin holds the admin tier on all 6 codes via Platform
 * Admin's everyFunction grant. Writes that mutate accounts use the
 * write tier on the matching code; reads use read.
 */
@ApiTags('CRM (Internal)')
@Controller('internal/crm')
@PlatformScoped()
export class CrmController {
  constructor(
    private readonly accounts: AccountService,
    private readonly subscriptions: SubscriptionService,
    private readonly contacts: ContactService,
    private readonly onboarding: OnboardingService,
    private readonly healthScores: HealthScoreService,
    private readonly renewals: RenewalService,
  ) {}

  // ── Accounts ─────────────────────────────────────────────────────

  @Get('accounts')
  @RequirePermission('crm-001:read')
  @ApiOperation({ summary: 'List CRM accounts with optional status + renewal-date filters.' })
  listAccounts(@Query() query: ListAccountsArgs) {
    return this.accounts.list(query);
  }

  @Get('accounts/:id')
  @RequirePermission('crm-001:read')
  @ApiOperation({ summary: 'Get a single CRM account.' })
  getAccount(@Param('id') id: string) {
    return this.accounts.getById(id);
  }

  @Get('accounts/:id/timeline')
  @RequirePermission('crm-001:read')
  @ApiOperation({
    summary:
      'Account timeline — interactions + health scores + onboarding progress + subscriptions + renewals.',
  })
  getTimeline(@Param('id') id: string) {
    return this.accounts.getTimeline(id);
  }

  @Post('accounts')
  @RequirePermission('crm-001:write')
  @ApiOperation({ summary: 'Create a new CRM account in PROSPECT status.' })
  createAccount(@Body() body: CreateAccountDto) {
    return this.accounts.create(body);
  }

  @Patch('accounts/:id')
  @RequirePermission('crm-001:write')
  @ApiOperation({ summary: 'Update an account.' })
  patchAccount(@Param('id') id: string, @Body() body: PatchAccountDto) {
    return this.accounts.patch(id, body);
  }

  @Patch('accounts/:id/status')
  @RequirePermission('crm-001:write')
  @ApiOperation({
    summary:
      'Transition account lifecycle status (validates prerequisites: PILOT requires signed_date; ONBOARDING > ACTIVE requires checklist COMPLETED).',
  })
  transitionStatus(@Param('id') id: string, @Body() body: TransitionAccountStatusDto) {
    return this.accounts.transitionStatus(id, body.status);
  }

  // ── Subscriptions ────────────────────────────────────────────────

  @Get('subscriptions')
  @RequirePermission('crm-003:read')
  @ApiOperation({ summary: 'List subscriptions, optionally scoped to an account.' })
  listSubscriptions(@Query('accountId') accountId?: string) {
    return this.subscriptions.list(accountId);
  }

  @Post('subscriptions')
  @RequirePermission('crm-003:write')
  @ApiOperation({ summary: 'Create a subscription.' })
  createSubscription(@Body() body: CreateSubscriptionDto) {
    return this.subscriptions.create(body);
  }

  @Patch('subscriptions/:id')
  @RequirePermission('crm-003:write')
  @ApiOperation({ summary: 'Update a subscription (e.g. Stripe webhook sync).' })
  patchSubscription(@Param('id') id: string, @Body() body: PatchSubscriptionDto) {
    return this.subscriptions.patch(id, body);
  }

  @Get('mrr-summary')
  @RequirePermission('crm-003:read')
  @ApiOperation({ summary: 'Aggregate MRR + per-status subscription counts.' })
  mrrSummary() {
    return this.subscriptions.mrrSummary();
  }

  // ── Contacts ─────────────────────────────────────────────────────

  @Get('accounts/:accountId/contacts')
  @RequirePermission('crm-004:read')
  @ApiOperation({ summary: 'List contacts on an account.' })
  listContacts(@Param('accountId') accountId: string) {
    return this.contacts.listForAccount(accountId);
  }

  @Post('accounts/:accountId/contacts')
  @RequirePermission('crm-004:write')
  @ApiOperation({ summary: 'Create a contact on an account.' })
  createContact(@Param('accountId') accountId: string, @Body() body: CreateContactDto) {
    return this.contacts.create(accountId, body);
  }

  @Patch('contacts/:id')
  @RequirePermission('crm-004:write')
  @ApiOperation({ summary: 'Update a contact.' })
  patchContact(@Param('id') id: string, @Body() body: PatchContactDto) {
    return this.contacts.patch(id, body);
  }

  @Delete('contacts/:id')
  @HttpCode(204)
  @RequirePermission('crm-004:write')
  @ApiOperation({ summary: 'Remove a contact.' })
  async removeContact(@Param('id') id: string): Promise<void> {
    await this.contacts.remove(id);
  }

  // ── Interactions ─────────────────────────────────────────────────

  @Get('accounts/:accountId/interactions')
  @RequirePermission('crm-006:read')
  @ApiOperation({ summary: 'List interactions on an account.' })
  listInteractions(@Param('accountId') accountId: string) {
    return this.contacts.listInteractions(accountId);
  }

  @Post('accounts/:accountId/interactions')
  @RequirePermission('crm-006:write')
  @ApiOperation({ summary: 'Log an interaction.' })
  createInteraction(
    @Req() req: AuthedRequest,
    @Param('accountId') accountId: string,
    @Body() body: CreateInteractionDto,
  ) {
    return this.contacts.createInteraction(accountId, req.user.personId ?? req.user.sub, body);
  }

  // ── Onboarding ───────────────────────────────────────────────────

  @Get('accounts/:accountId/onboarding')
  @RequirePermission('crm-002:read')
  @ApiOperation({
    summary: 'Get the onboarding checklist for an account (null if not yet initialised).',
  })
  getOnboarding(@Param('accountId') accountId: string) {
    return this.onboarding.getForAccount(accountId);
  }

  @Post('accounts/:accountId/onboarding')
  @RequirePermission('crm-002:write')
  @ApiOperation({
    summary:
      'Initialise the onboarding checklist for an account from a template (default 8-task template applied when no tasks supplied).',
  })
  initOnboarding(@Param('accountId') accountId: string, @Body() body: InitOnboardingDto) {
    return this.onboarding.init(accountId, body);
  }

  @Patch('onboarding-tasks/:taskId')
  @RequirePermission('crm-002:write')
  @ApiOperation({
    summary:
      'Patch an onboarding task status (PENDING, COMPLETED, SKIPPED). When the checklist hits all-non-PENDING the parent account auto-flips ONBOARDING > ACTIVE.',
  })
  patchOnboardingTask(
    @Req() req: AuthedRequest,
    @Param('taskId') taskId: string,
    @Body() body: PatchOnboardingTaskDto,
  ) {
    return this.onboarding.patchTask(taskId, req.user.personId ?? req.user.sub, body);
  }

  // ── Health Scores ────────────────────────────────────────────────

  @Get('accounts/:accountId/health')
  @RequirePermission('crm-005:read')
  @ApiOperation({ summary: 'Health-score history for an account (newest first, max 52 weeks).' })
  getAccountHealth(@Param('accountId') accountId: string) {
    return this.healthScores.listForAccount(accountId);
  }

  @Get('health/at-risk')
  @RequirePermission('crm-005:read')
  @ApiOperation({
    summary: 'List accounts whose latest health score is AT_RISK or CRITICAL, severity-sorted.',
  })
  atRisk() {
    return this.healthScores.atRisk();
  }

  @Post('accounts/:accountId/health/recompute')
  @RequirePermission('crm-005:write')
  @ApiOperation({
    summary:
      'Manually recompute today’s health score for an account (the HealthScoreWorker normally does this weekly).',
  })
  recomputeHealth(@Param('accountId') accountId: string) {
    const today = new Date().toISOString().slice(0, 10);
    return this.healthScores.computeForAccount(accountId, today);
  }

  @Post('accounts/:accountId/health')
  @RequirePermission('crm-005:write')
  @ApiOperation({ summary: 'Manually record a health score row (overrides any compute).' })
  recordHealth(@Param('accountId') accountId: string, @Body() body: CreateHealthScoreDto) {
    return this.healthScores.recordScore(accountId, body);
  }

  // ── Renewals ─────────────────────────────────────────────────────

  @Get('renewals')
  @RequirePermission('crm-001:read')
  @ApiOperation({ summary: 'Renewal pipeline. Optional stage filter.' })
  listRenewals(@Query('stage') stage?: string) {
    const normalised: RenewalStage | undefined =
      stage && (RENEWAL_STAGES as readonly string[]).includes(stage)
        ? (stage as RenewalStage)
        : undefined;
    return this.renewals.list(normalised);
  }

  @Get('renewals/upcoming')
  @RequirePermission('crm-001:read')
  @ApiOperation({ summary: 'Renewals due in the next 90 days (configurable via ?days=).' })
  upcomingRenewals(@Query('days') days?: string) {
    const parsed = days ? Number(days) : 90;
    const safe = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 365) : 90;
    return this.renewals.upcoming(safe);
  }

  @Get('renewals/:id')
  @RequirePermission('crm-001:read')
  @ApiOperation({ summary: 'Get a single renewal.' })
  getRenewal(@Param('id') id: string) {
    return this.renewals.getById(id);
  }

  @Post('renewals')
  @RequirePermission('crm-001:write')
  @ApiOperation({ summary: 'Create a renewal pipeline entry.' })
  createRenewal(@Body() body: CreateRenewalDto) {
    return this.renewals.create(body);
  }

  @Patch('renewals/:id')
  @RequirePermission('crm-001:write')
  @ApiOperation({ summary: 'Update a renewal pipeline entry.' })
  patchRenewal(@Param('id') id: string, @Body() body: PatchRenewalDto) {
    return this.renewals.patch(id, body);
  }

  // ── Catalogue ────────────────────────────────────────────────────

  @Get('catalogue/lifecycle-statuses')
  @RequirePermission('crm-001:read')
  @ApiOperation({ summary: 'Enum catalogue used by the UI dropdowns.' })
  lifecycleCatalogue() {
    return {
      accountStatuses: ACCOUNT_STATUSES,
      renewalStages: RENEWAL_STAGES,
    };
  }
}
