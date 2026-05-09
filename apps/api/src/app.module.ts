import { Module, Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { HealthModule } from './health/health.module';
import { TenantModule } from './tenant/tenant.module';
import { PlatformModule } from './platform/platform.module';
import { IamModule } from './iam/iam.module';
import { AuthModule } from './auth/auth.module';
import { SisModule } from './sis/sis.module';
import { AttendanceModule } from './attendance/attendance.module';
import { ClassroomModule } from './classroom/classroom.module';
import { HrModule } from './hr/hr.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { EnrollmentModule } from './enrollment/enrollment.module';
import { PaymentsModule } from './payments/payments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MessagingModule } from './messaging/messaging.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { ProfileModule } from './profile/profile.module';
import { HouseholdsModule } from './households/households.module';
import { TasksModule } from './tasks/tasks.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { TicketsModule } from './tickets/tickets.module';
import { DisciplineModule } from './discipline/discipline.module';
import { BehaviorPlansModule } from './behavior-plans/behavior-plans.module';
import { HealthRecordsModule } from './health/health-records.module';
import { CounsellingModule } from './counselling/counselling.module';
import { WellbeingModule } from './wellbeing/wellbeing.module';
import { LibraryModule } from './library/library.module';
import { AthleticsModule } from './athletics/athletics.module';
import { EmergencyAlertsModule } from './emergency-alerts/emergency-alerts.module';
import { MeetingsModule } from './meetings/meetings.module';
import { ClubsModule } from './clubs/clubs.module';
import { GroupsModule } from './groups/groups.module';
import { TransportModule } from './transport/transport.module';
import { FoodServiceModule } from './food-service/food-service.module';
import { FacilitiesModule } from './facilities/facilities.module';
import { ItModule } from './it/it.module';
import { CurriculumModule } from './curriculum/curriculum.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { PublicationsModule } from './publications/publications.module';
import { FinanceModule } from './finance/finance.module';
import { ProcurementModule } from './procurement/procurement.module';
import { StoreModule } from './store/store.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { GovernanceModule } from './governance/governance.module';
import { ObservabilityModule } from './observability/observability.module';
import { DlqModule } from './dlq/dlq.module';
import { PlatformAdminModule } from './platform-admin/platform-admin.module';
import { ConfigurationModule } from './configuration/configuration.module';
import { RegionModule } from './region/region.module';
import { VisitorsModule } from './visitors/visitors.module';
import { IncidentsModule } from './incidents/incidents.module';
import { HealthAdvancedModule } from './health-advanced/health-advanced.module';
import { PayrollModule } from './payroll/payroll.module';
import { RecruitmentModule } from './recruitment/recruitment.module';
import { TrainingModule } from './training/training.module';
import { AppraisalsModule } from './appraisals/appraisals.module';
import { KafkaModule } from './kafka/kafka.module';
import { TenantGuard } from './tenant/tenant.guard';
import { AuthGuard } from './auth/auth.guard';
import { PermissionGuard } from './auth/permission.guard';
import { GuardTestController } from './guard-test.controller';

/**
 * CampusOS Root Application Module
 *
 * Guard chain on every protected request:
 * TenantResolverMiddleware -> AuthGuard (global) -> TenantGuard (global) -> PermissionGuard (global)
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
    HealthModule,
    TenantModule,
    AuthModule,
    PlatformModule,
    IamModule,
    KafkaModule,
    SisModule,
    AttendanceModule,
    ClassroomModule,
    HrModule,
    SchedulingModule,
    EnrollmentModule,
    PaymentsModule,
    NotificationsModule,
    MessagingModule,
    AnnouncementsModule,
    ProfileModule,
    HouseholdsModule,
    TasksModule,
    WorkflowsModule,
    TicketsModule,
    DisciplineModule,
    BehaviorPlansModule,
    HealthRecordsModule,
    CounsellingModule,
    WellbeingModule,
    LibraryModule,
    AthleticsModule,
    EmergencyAlertsModule,
    MeetingsModule,
    ClubsModule,
    GroupsModule,
    TransportModule,
    FoodServiceModule,
    FacilitiesModule,
    ItModule,
    CurriculumModule,
    PortfolioModule,
    PublicationsModule,
    FinanceModule,
    ProcurementModule,
    StoreModule,
    AnalyticsModule,
    GovernanceModule,
    DlqModule,
    PlatformAdminModule,
    ConfigurationModule,
    // Cycle 32 Step 6 — registers the RegionMismatchInterceptor
    // globally; gates @HomeRegionRequired() routes on
    // tenant.homeRegion === process.env.AWS_REGION.
    RegionModule,
    // Phase 2 Cycle 1 — M90 Visitor Management. Encrypted PII +
    // HMAC blind index for kiosk lookup, banned-persons HMAC
    // screening, emergency muster snapshot.
    VisitorsModule,
    // Phase 2 Cycle 2 — M91 Incident & Emergency. Atomic emergency
    // declarations + declaration outbox orchestration, immutable
    // incident timeline, real-time accountability summary, identity-
    // verified reunification, drills, non-discipline incident reports.
    IncidentsModule,
    // Phase 2 Cycle 3 — M23 Health Advanced. Telehealth provider
    // directory + session scheduling with HIPAA access-log writes,
    // immunisation compliance computation with nightly worker +
    // state CSV report, screening referrals with overdue tracking.
    HealthAdvancedModule,
    // Phase 2 Cycle 4 sub-cycle a — Payroll. Pay grade catalogue,
    // salary scales, pay periods, payroll records with deduction
    // computation, salary review queue. Emits hr.payroll.processed
    // for the Cycle 26 GLConsumer to post salary journal entries.
    PayrollModule,
    // Phase 2 Cycle 4 sub-cycle b — Recruitment. Job postings (with
    // public job-board endpoint), applications (with public apply
    // path), interview panels, scheduling, evaluations, offers.
    // OfferService.respond ACCEPTED auto-creates hr_employees +
    // hr_employee_positions in the same tx and enqueues
    // hr.offer.accepted via OutboxService.enqueueInTx.
    RecruitmentModule,
    // P2-4c — Training & Certifications (M80 Workforce Core
    // additional surface). Programmes + events + completions +
    // certification types + employee certifications. Emits
    // hr.training.completed via OutboxService.enqueueInTx and runs
    // the AUTO-ISSUE keystone (matching hr_certification_types row
    // gets an hr_employee_certifications row stamped on completion
    // of mandatory programmes with renewal_months populated).
    TrainingModule,
    // P2-4c — Appraisals + Lesson Observations + Expense Claims.
    // SIGNED_OFF is the immutable terminal status on hr_appraisals
    // (mirrors Cycle 11 svc_session_notes locked + P2C3 telehealth
    // COMPLETED). Lesson observations are KEYSTONE-gated on the
    // new lesson_observation:write permission held only by School
    // Admin / Platform Admin via everyFunction. Expense claims
    // workflow uses multi-column decided_chk schema lockstep.
    AppraisalsModule,
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
