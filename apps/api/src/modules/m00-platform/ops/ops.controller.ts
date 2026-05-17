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
  CreateAccountAssignmentDto,
  CreateInternalTicketDto,
  CreateOpsEmployeeDto,
  CreatePricingBandDto,
  CreateSupportTierDto,
  CreateTenantAccessGrantDto,
  CreateTicketCommentDto,
  GrantPermissionDto,
  ListInternalTicketsArgs,
  OPS_DEPARTMENTS,
  OPS_PERMISSION_SCOPES,
  PatchInternalTicketDto,
  PatchOpsEmployeeDto,
  PatchSupportTierDto,
  TENANT_ACCESS_TYPES,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  UpdatePricingBandDto,
} from './dto/ops.dto';
import { AccountAssignmentService } from './services/account-assignment.service';
import { InternalTicketService } from './services/internal-ticket.service';
import { OpsEmployeeService } from './services/ops-employee.service';
import { PricingService } from './services/pricing.service';
import { TenantAccessService } from './services/tenant-access.service';

interface AuthedRequest extends Request {
  user: { sub: string; personId?: string };
}

/**
 * P2-21b — Internal Ops + Pricing Controller.
 *
 * Routes mounted under /api/v1/internal/{ops,pricing}/* and gated as
 * platform-scoped via @PlatformScoped() — no tenant header required;
 * permission resolution against the PLATFORM IAM scope.
 *
 * Permission tiers (existing catalogue codes, see permissions.json):
 *   OPS-001 Internal Task Management → ops_employees + ops_permissions
 *   OPS-002 Knowledge Base           → ops_account_assignments
 *   OPS-003 Incident Management      → ops_tenant_access_grants (FERPA/GDPR audit)
 *   OPS-004 Release Management       → ops_internal_tickets + comments
 *   OPS-005 Support Tier Management  → platform_pricing_bands + history + support tiers
 *   OPS-006 Platform Analytics       → cross-cutting reads + analytics rollups
 *
 * Platform Admin holds the admin tier on all 6 codes via everyFunction
 * at PLATFORM scope. School admins / teachers / parents / students
 * cannot reach these routes — @PlatformScoped resolves permissions
 * against the PLATFORM scope only, and the IAM seed grants ops-001/
 * sch-001 at SCHOOL scope (not PLATFORM) for non-platform-admin roles.
 */
@ApiTags('Internal Ops (Platform)')
@Controller('internal')
@PlatformScoped()
export class OpsController {
  constructor(
    private readonly employees: OpsEmployeeService,
    private readonly assignments: AccountAssignmentService,
    private readonly tenantAccess: TenantAccessService,
    private readonly tickets: InternalTicketService,
    private readonly pricing: PricingService,
  ) {}

  // ── Ops Employees ────────────────────────────────────────────────

  @Get('employees')
  @RequirePermission('ops-001:read')
  @ApiOperation({ summary: 'List CampusOS employees.' })
  listEmployees(
    @Query('department') department?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    const dept =
      department && (OPS_DEPARTMENTS as readonly string[]).includes(department)
        ? (department as (typeof OPS_DEPARTMENTS)[number])
        : undefined;
    return this.employees.list({
      department: dept,
      includeInactive: includeInactive === 'true',
    });
  }

  @Get('employees/:id')
  @RequirePermission('ops-001:read')
  @ApiOperation({ summary: 'Get one CampusOS employee.' })
  getEmployee(@Param('id') id: string) {
    return this.employees.getById(id);
  }

  @Post('employees')
  @RequirePermission('ops-001:write')
  @ApiOperation({ summary: 'Create a new CampusOS employee.' })
  createEmployee(@Body() body: CreateOpsEmployeeDto) {
    return this.employees.create(body);
  }

  @Patch('employees/:id')
  @RequirePermission('ops-001:write')
  @ApiOperation({ summary: 'Patch a CampusOS employee.' })
  patchEmployee(@Param('id') id: string, @Body() body: PatchOpsEmployeeDto) {
    return this.employees.patch(id, body);
  }

  @Get('employees/:id/permissions')
  @RequirePermission('ops-001:read')
  @ApiOperation({ summary: 'List the ops_permissions held by an employee.' })
  listEmployeePermissions(@Param('id') id: string) {
    return this.employees.listPermissions(id);
  }

  @Post('employees/:id/permissions')
  @RequirePermission('ops-001:write')
  @ApiOperation({
    summary:
      'Grant an ops_permissions scope to an employee. UNIQUE(employee, scope) so duplicates 409.',
  })
  grantPermission(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: GrantPermissionDto,
  ) {
    // granted_by must be an ops_employees row — we resolve it via the
    // request user's personId, but the simplest contract for the
    // internal dashboard is the caller supplies their own ops_employees
    // id implicitly via the URL or auth header. For now we accept the
    // caller's auth context sub as the granter and assume the seeded
    // platform admin has been bridged to an ops_employees row before
    // hitting this surface.
    const grantedBy = req.user.personId ?? req.user.sub;
    return this.employees.grantPermission(id, grantedBy, body);
  }

  @Delete('permissions/:permissionId')
  @HttpCode(204)
  @RequirePermission('ops-001:write')
  @ApiOperation({ summary: 'Revoke an ops_permissions row.' })
  async revokePermission(@Param('permissionId') permissionId: string): Promise<void> {
    await this.employees.revokePermission(permissionId);
  }

  // ── Account Assignments ──────────────────────────────────────────

  @Get('account-assignments/by-account/:accountId')
  @RequirePermission('ops-002:read')
  @ApiOperation({ summary: 'List ops_account_assignments for a given crm_account.' })
  listAssignmentsForAccount(@Param('accountId') accountId: string) {
    return this.assignments.listForAccount(accountId);
  }

  @Get('account-assignments/by-employee/:employeeId')
  @RequirePermission('ops-002:read')
  @ApiOperation({ summary: 'List account assignments for an employee (their book of business).' })
  listAssignmentsForEmployee(@Param('employeeId') employeeId: string) {
    return this.assignments.listForEmployee(employeeId);
  }

  @Post('account-assignments')
  @RequirePermission('ops-002:write')
  @ApiOperation({ summary: 'Create an ops_account_assignments row.' })
  createAssignment(@Body() body: CreateAccountAssignmentDto) {
    return this.assignments.create(body);
  }

  @Delete('account-assignments/:id')
  @HttpCode(204)
  @RequirePermission('ops-002:write')
  @ApiOperation({ summary: 'Remove an ops_account_assignments row.' })
  async removeAssignment(@Param('id') id: string): Promise<void> {
    await this.assignments.remove(id);
  }

  // ── Tenant Access Grants (FERPA/GDPR keystone) ───────────────────

  @Get('tenant-access/active')
  @RequirePermission('ops-003:read')
  @ApiOperation({
    summary:
      'List currently-active tenant access grants (revoked_at IS NULL AND expires_at > now()).',
  })
  listActiveTenantAccess() {
    return this.tenantAccess.listActive();
  }

  @Get('tenant-access/audit-log')
  @RequirePermission('ops-003:read')
  @ApiOperation({ summary: 'Full audit log of tenant access grants.' })
  listTenantAccessAuditLog(
    @Query('employeeId') employeeId?: string,
    @Query('tenantSchema') tenantSchema?: string,
  ) {
    return this.tenantAccess.listAuditLog({ employeeId, tenantSchema });
  }

  @Get('tenant-access/:id')
  @RequirePermission('ops-003:read')
  @ApiOperation({ summary: 'Get one tenant access grant.' })
  getTenantAccess(@Param('id') id: string) {
    return this.tenantAccess.getById(id);
  }

  @Post('tenant-access')
  @RequirePermission('ops-003:write')
  @ApiOperation({
    summary:
      'Grant a CampusOS employee time-bounded access to a tenant schema. Hard 4-hour maximum (duration_chk). Mandatory justification of >= 20 chars (justification_chk). Approver must have INTERNAL_ADMIN ops_permissions scope. Emits ops.tenant_access.granted.',
  })
  grantTenantAccess(@Body() body: CreateTenantAccessGrantDto) {
    return this.tenantAccess.grant(body);
  }

  @Post('tenant-access/:id/revoke')
  @RequirePermission('ops-003:write')
  @ApiOperation({ summary: 'Manually revoke a tenant access grant.' })
  revokeTenantAccess(@Req() req: AuthedRequest, @Param('id') id: string) {
    const revokedBy = req.user.personId ?? req.user.sub;
    return this.tenantAccess.revoke(id, revokedBy);
  }

  // ── Internal Tickets ─────────────────────────────────────────────

  @Get('tickets')
  @RequirePermission('ops-004:read')
  @ApiOperation({
    summary: 'List internal tickets with optional status/priority/assignee filters.',
  })
  listTickets(@Query() query: ListInternalTicketsArgs) {
    return this.tickets.list(query);
  }

  @Get('tickets/:id')
  @RequirePermission('ops-004:read')
  @ApiOperation({ summary: 'Get one internal ticket.' })
  getTicket(@Param('id') id: string) {
    return this.tickets.getById(id);
  }

  @Post('tickets')
  @RequirePermission('ops-004:write')
  @ApiOperation({ summary: 'Create an internal ticket.' })
  createTicket(@Req() req: AuthedRequest, @Body() body: CreateInternalTicketDto) {
    const createdBy = req.user.personId ?? req.user.sub;
    return this.tickets.create(createdBy, body);
  }

  @Patch('tickets/:id')
  @RequirePermission('ops-004:write')
  @ApiOperation({ summary: 'Update an internal ticket.' })
  patchTicket(@Param('id') id: string, @Body() body: PatchInternalTicketDto) {
    return this.tickets.patch(id, body);
  }

  @Get('tickets/:id/comments')
  @RequirePermission('ops-004:read')
  @ApiOperation({ summary: 'List comments on an internal ticket.' })
  listTicketComments(@Param('id') id: string) {
    return this.tickets.listComments(id);
  }

  @Post('tickets/:id/comments')
  @RequirePermission('ops-004:write')
  @ApiOperation({ summary: 'Add a comment to an internal ticket.' })
  addTicketComment(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CreateTicketCommentDto,
  ) {
    const authorId = req.user.personId ?? req.user.sub;
    return this.tickets.addComment(id, authorId, body);
  }

  // ── Pricing ──────────────────────────────────────────────────────

  @Get('pricing/bands')
  @RequirePermission('ops-005:read')
  @ApiOperation({ summary: 'List pricing bands.' })
  listPricingBands(@Query('includeInactive') includeInactive?: string) {
    return this.pricing.listBands(includeInactive === 'true');
  }

  @Get('pricing/bands/:id')
  @RequirePermission('ops-005:read')
  @ApiOperation({ summary: 'Get one pricing band.' })
  getPricingBand(@Param('id') id: string) {
    return this.pricing.getBand(id);
  }

  @Post('pricing/bands')
  @RequirePermission('ops-005:write')
  @ApiOperation({ summary: 'Create a new pricing band.' })
  createPricingBand(@Body() body: CreatePricingBandDto) {
    return this.pricing.createBand(body);
  }

  @Patch('pricing/bands/:id')
  @RequirePermission('ops-005:write')
  @ApiOperation({
    summary:
      'Update a pricing band. When monthly_price_cents or annual_price_cents change, a platform_pricing_history row is written inside the same tx as the UPDATE (audit trail). changedBy is required for price changes.',
  })
  updatePricingBand(@Param('id') id: string, @Body() body: UpdatePricingBandDto) {
    return this.pricing.updateBand(id, body);
  }

  @Get('pricing/bands/:id/history')
  @RequirePermission('ops-005:read')
  @ApiOperation({ summary: 'Price change history for a band.' })
  listPricingHistory(@Param('id') id: string) {
    return this.pricing.listHistoryForBand(id);
  }

  @Get('pricing/history')
  @RequirePermission('ops-005:read')
  @ApiOperation({ summary: 'Full price change audit trail across all bands.' })
  listAllPricingHistory() {
    return this.pricing.listAllHistory();
  }

  @Get('pricing/support-tiers')
  @RequirePermission('ops-005:read')
  @ApiOperation({ summary: 'List support tiers.' })
  listSupportTiers(@Query('includeInactive') includeInactive?: string) {
    return this.pricing.listSupportTiers(includeInactive === 'true');
  }

  @Post('pricing/support-tiers')
  @RequirePermission('ops-005:write')
  @ApiOperation({ summary: 'Create a support tier.' })
  createSupportTier(@Body() body: CreateSupportTierDto) {
    return this.pricing.createSupportTier(body);
  }

  @Patch('pricing/support-tiers/:id')
  @RequirePermission('ops-005:write')
  @ApiOperation({ summary: 'Update a support tier.' })
  patchSupportTier(@Param('id') id: string, @Body() body: PatchSupportTierDto) {
    return this.pricing.patchSupportTier(id, body);
  }

  // ── Catalogue ────────────────────────────────────────────────────

  @Get('ops/catalogue')
  @RequirePermission('ops-001:read')
  @ApiOperation({ summary: 'Enum catalogue used by the UI dropdowns.' })
  catalogue() {
    return {
      departments: OPS_DEPARTMENTS,
      permissionScopes: OPS_PERMISSION_SCOPES,
      tenantAccessTypes: TENANT_ACCESS_TYPES,
      ticketCategories: TICKET_CATEGORIES,
      ticketPriorities: TICKET_PRIORITIES,
      ticketStatuses: TICKET_STATUSES,
    };
  }
}
