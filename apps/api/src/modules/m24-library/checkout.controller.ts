import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { CheckoutService } from './checkout.service';
import {
  CHECKOUT_STATUSES,
  CheckoutCreateDto,
  CheckoutPolicyResponseDto,
  CheckoutResponseDto,
  CheckoutStatus,
} from './dto/library.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library — Circulation')
@ApiBearerAuth()
@Controller('library')
export class CheckoutController {
  constructor(
    private readonly checkouts: CheckoutService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('checkout-policies')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'List the checkout policies for this school (one per patron type). Patrons hit this endpoint to see their own loan window + fine rate before borrowing.',
  })
  async listPolicies(): Promise<CheckoutPolicyResponseDto[]> {
    return this.checkouts.listPolicies();
  }

  @Get('checkouts')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'List checkouts. Librarian and admin see all; patrons see only their own (row-scoped at the service layer to actor.personId). Optional ?status= filter; ?onlyActive=true filters returned_at IS NULL; librarians can pass ?patronId=<uuid> to see another patron’s history.',
  })
  async list(
    @Query('status') statusRaw: string | undefined,
    @Query('patronId') patronId: string | undefined,
    @Query('onlyActive') onlyActiveRaw: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<CheckoutResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const status =
      statusRaw && (CHECKOUT_STATUSES as readonly string[]).includes(statusRaw)
        ? (statusRaw as CheckoutStatus)
        : undefined;
    const onlyActive =
      onlyActiveRaw === 'true' ? true : onlyActiveRaw === 'false' ? false : undefined;
    return this.checkouts.list({ status, patronId, onlyActive }, actor);
  }

  @Get('checkouts/overdue')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'Librarian dashboard of overdue items — every active checkout where due_date < today. Service-layer 403 for non-librarian patrons.',
  })
  async listOverdue(@Req() req: AuthedRequest): Promise<CheckoutResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.checkouts.listOverdue(actor);
  }

  @Get('checkouts/:id')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      "Fetch a single checkout by id. Row-scoped at the service layer: librarians and admins see any checkout in tenant; patrons see only their own; non-owners get a 404 (don't-leak-existence per REVIEW-CYCLE12 BLOCKING 1).",
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<CheckoutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.checkouts.getById(id, actor);
  }

  @Post('checkouts')
  @RequirePermission('lib-002:write')
  @ApiOperation({
    summary:
      'Checkout-by-barcode keystone. Librarian or admin scans a barcode (or supplies a copyId), passes the patronId, and the service resolves the copy + locks it FOR UPDATE + validates max_checkouts policy + validates is_available + creates the checkout row + flips copy state to CHECKED_OUT all in one tenant transaction. due_date defaults to checkout_date + policy.loan_period_days; the optional loanPeriodDays override is for short-loan reading-room copies.',
  })
  async create(
    @Body() body: CheckoutCreateDto,
    @Req() req: AuthedRequest,
  ): Promise<CheckoutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.checkouts.checkout(body, actor);
  }

  @Post('checkouts/:id/return')
  @RequirePermission('lib-002:write')
  @ApiOperation({
    summary:
      'Return a checkout. Librarian or admin only. Stamps returned_at + flips status to RETURNED inside one tenant tx; auto-creates an OVERDUE fine with amount = days_overdue × policy.overdue_fine_per_day when the return is past due AND the policy carries a non-zero fine rate; walks the hold queue — the oldest PENDING hold for the parent item flips to READY with notified_at populated and the copy walks to ON_HOLD_SHELF; otherwise the copy returns to ON_SHELF (is_available=true). Emits lib.fine.issued after the tx commits when a fine is created.',
  })
  async returnCheckout(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<CheckoutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.checkouts.returnCheckout(id, actor);
  }

  @Post('checkouts/:id/renew')
  @RequirePermission('lib-002:write')
  @ApiOperation({
    summary:
      'Renew a checkout. Librarian or admin only. Validates the checkout is ACTIVE or OVERDUE + the patron has not exceeded policy.renewals_allowed. Extends due_date by policy.loan_period_days and bumps renewal_count. Resets status to ACTIVE if previously OVERDUE.',
  })
  async renew(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<CheckoutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.checkouts.renew(id, actor);
  }
}
