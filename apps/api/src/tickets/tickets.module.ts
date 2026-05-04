import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { CategoryService } from './category.service';
import { CategoryController } from './category.controller';
import { SlaService } from './sla.service';
import { SlaController } from './sla.controller';
import { VendorService } from './vendor.service';
import { VendorController } from './vendor.controller';
import { ActivityService } from './activity.service';
import { ActivityController } from './activity.controller';
import { CommentService } from './comment.service';
import { CommentController } from './comment.controller';
import { ProblemService } from './problem.service';
import { ProblemController } from './problem.controller';
import { TicketService } from './ticket.service';
import { TicketController } from './ticket.controller';

/**
 * Tickets Module — M60 Service Tickets (Cycle 8).
 *
 * Steps 4 + 5 ship the request-path API on top of the Step 1 + Step 2
 * schemas and the Step 3 seed.
 *
 * Services:
 *   - CategoryService   — category + subcategory CRUD; inlines subcategories
 *                         in the list response. Auto-assignment hints
 *                         (default_assignee_id, auto_assign_to_role) live
 *                         on subcategory rows.
 *   - SlaService        — SLA policy upsert + computeSnapshot helper. The
 *                         clock is computed not stored; admin reads
 *                         surface response/resolution remaining hours
 *                         from now() against the policy.
 *   - VendorService     — vendor registry CRUD with preferred-first list
 *                         sort.
 *   - ActivityService   — IMMUTABLE-by-discipline audit log. Step 5
 *                         hoisted recordActivity() out of TicketService
 *                         so CommentService and ProblemService write
 *                         through the same path.
 *   - CommentService    — public + internal comment thread on a ticket.
 *                         Step 5. Visibility filter at the service layer
 *                         (requester sees public only; assignee + admin
 *                         see all). First staff comment bumps
 *                         first_response_at and stops the SLA response
 *                         clock. Emits tkt.ticket.commented.
 *   - ProblemService    — Step 5. Root-cause grouping for related
 *                         tickets. Admin-only. resolveBatch locks the
 *                         problem row + every linked active ticket
 *                         FOR UPDATE in one tx, flips problem to
 *                         RESOLVED, batch-flips matching tickets to
 *                         RESOLVED, emits one tkt.ticket.resolved per
 *                         flipped ticket.
 *   - TicketService     — ticket lifecycle. Auto-assignment chain on
 *                         submission (default_assignee_id → role → admin
 *                         queue), SLA auto-link, locked-row state machine
 *                         transitions for assign / assign-vendor / resolve
 *                         / close / reopen / cancel. Emits tkt.ticket.
 *                         submitted / assigned / resolved.
 *
 * Authorisation contract:
 *   - it-001:read   — list + read tickets, comments, activity log,
 *                     categories, vendors, SLA matrix, problems.
 *                     Row-scoped at the service layer for non-admins.
 *   - it-001:write  — submit + lifecycle transitions on tickets the caller
 *                     can act on (requester or assignee path); post
 *                     comments to participating tickets.
 *   - it-001:admin  — category / subcategory / SLA / vendor management;
 *                     ticket assign + assign-vendor; problem CRUD and
 *                     batch-resolve.
 *
 * The tkt.ticket.assigned emit feeds the Cycle 7 TaskWorker via the
 * seeded auto-task rule (Step 3); the worker resolves the assignee via
 * the payload's recipientAccountId / accountId fallback and writes a
 * TODO task on the assignee's to-do list.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    CategoryService,
    SlaService,
    VendorService,
    ActivityService,
    CommentService,
    ProblemService,
    TicketService,
  ],
  controllers: [
    CategoryController,
    SlaController,
    VendorController,
    ActivityController,
    CommentController,
    ProblemController,
    TicketController,
  ],
  exports: [
    CategoryService,
    SlaService,
    VendorService,
    ActivityService,
    CommentService,
    ProblemService,
    TicketService,
  ],
})
export class TicketsModule {}
