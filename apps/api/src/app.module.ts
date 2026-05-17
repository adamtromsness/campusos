import { Module, Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

// ── Cross-cutting infrastructure ─────────────────────────────────────
import { ObservabilityModule } from '@shared/observability/observability.module';
import { DlqModule } from '@shared/dlq/dlq.module';
import { KafkaModule } from '@shared/kafka';
import { AuthGuard } from '@shared/auth';
import { PermissionGuard } from '@shared/auth';

// ── 37 canonical modules (M-numbered, one per module directory) ──────
import { M00PlatformModule } from '@modules/m00-platform/m00-platform.module';
import { WorkflowsModule } from '@modules/m02-workflows/workflows.module';
import { TasksModule } from '@modules/m03-tasks/tasks.module';
import { M09BehaviourModule } from '@modules/m09-behaviour/m09-behaviour.module';
import { M20SisModule } from '@modules/m20-sis/m20-sis.module';
import { M21ClassroomModule } from '@modules/m21-classroom/m21-classroom.module';
import { SchedulingModule } from '@modules/m22-scheduling/scheduling.module';
import { M23HealthModule } from '@modules/m23-health/m23-health.module';
import { LibraryModule } from '@modules/m24-library/library.module';
import { CurriculumModule } from '@modules/m25-curriculum/curriculum.module';
import { PortfolioModule } from '@modules/m26-portfolio/portfolio.module';
import { M27StudentServicesModule } from '@modules/m27-student-services/m27-student-services.module';
import { M40CommunicationsModule } from '@modules/m40-communications/m40-communications.module';
import { M41MeetingsModule } from '@modules/m41-meetings/m41-meetings.module';
import { PublicationsModule } from '@modules/m42-publications/publications.module';
import { TransportModule } from '@modules/m61-transport/transport.module';
import { ItModule } from '@modules/m62-it/it.module';
import { FoodServiceModule } from '@modules/m63-food-service/food-service.module';
import { M64ClubsModule } from '@modules/m64-clubs/m64-clubs.module';
import { FacilitiesModule } from '@modules/m65-facilities/facilities.module';
import { AthleticsModule } from '@modules/m66-athletics/athletics.module';
import { M67StoreModule } from '@modules/m67-store/m67-store.module';
import { M80HrModule } from '@modules/m80-hr/m80-hr.module';
import { M81EnrolmentModule } from '@modules/m81-enrolment/m81-enrolment.module';
import { SubstitutesModule } from '@modules/m82-substitutes/substitutes.module';
import { FinanceModule } from '@modules/m83-finance/finance.module';
import { PaymentsModule } from '@modules/m84-payments/payments.module';
import { AccreditationModule } from '@modules/m85-accreditation/accreditation.module';
import { ProcurementModule } from '@modules/m86-procurement/procurement.module';
import { M87SafetyModule } from '@modules/m87-safety/m87-safety.module';
import { VisitorsModule } from '@modules/m90-visitors/visitors.module';
import { TicketsModule } from '@modules/m60-tickets/tickets.module';
import { EngagementModule } from '@modules/m100-engagement/engagement.module';
import { EventsModule } from '@modules/m101-events/events.module';
import { AlumniModule } from '@modules/m102-alumni/alumni.module';
import { M103GroupsModule } from '@modules/m103-groups/m103-groups.module';
import { AnalyticsModule } from '@modules/m110-analytics/analytics.module';

// ── Guard pre-requisites ─────────────────────────────────────────────
import { TenantGuard } from '@modules/m00-platform/tenant/tenant.guard';
import { GuardTestController } from './guard-test.controller';

/**
 * CampusOS Root Application Module
 *
 * Guard chain on every protected request:
 * TenantResolverMiddleware -> AuthGuard (global) -> TenantGuard (global) -> PermissionGuard (global)
 *
 * Imports exactly 37 canonical modules — one per `apps/api/src/modules/m{XX}-*`
 * directory. Modules that contained multiple leaf NestJS modules (e.g. m00,
 * m20, m40, m80) are aggregated under their `m{XX}-{name}.module.ts` so this
 * file stays at 1 import per canonical module instead of 70+ leaf imports.
 *
 * GuardTestController is mounted only outside production. It exposes
 * /guard-test/* endpoints used to verify the guard chain end-to-end. In
 * production (NODE_ENV === 'production') the controller is excluded from
 * the route table entirely so there's no surface area to probe.
 */
var devOnlyControllers: Type<unknown>[] =
  process.env.NODE_ENV === 'production' ? [] : [GuardTestController];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Cycle 31 Step 1 — ObservabilityModule must register the
    // TraceIdMiddleware BEFORE TenantResolverMiddleware so the trace
    // context is established before tenant resolution. NestJS applies
    // middleware in module-import order.
    ObservabilityModule,
    KafkaModule,
    DlqModule,

    // 37 canonical modules, in ERD order.
    M00PlatformModule,
    WorkflowsModule,
    TasksModule,
    M09BehaviourModule,
    M20SisModule,
    M21ClassroomModule,
    SchedulingModule,
    M23HealthModule,
    LibraryModule,
    CurriculumModule,
    PortfolioModule,
    M27StudentServicesModule,
    M40CommunicationsModule,
    M41MeetingsModule,
    PublicationsModule,
    TicketsModule,
    TransportModule,
    ItModule,
    FoodServiceModule,
    M64ClubsModule,
    FacilitiesModule,
    AthleticsModule,
    M67StoreModule,
    M80HrModule,
    M81EnrolmentModule,
    SubstitutesModule,
    FinanceModule,
    PaymentsModule,
    AccreditationModule,
    ProcurementModule,
    M87SafetyModule,
    VisitorsModule,
    EngagementModule,
    EventsModule,
    AlumniModule,
    M103GroupsModule,
    AnalyticsModule,
  ],
  controllers: devOnlyControllers,
  providers: [
    // Global guards run in declaration order. Register all three here
    // so the order is explicit: Auth → Tenant → Permission.
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
  ],
})
export class AppModule {}
