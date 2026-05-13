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
import { ClassroomAdvancedModule } from './classroom-advanced/classroom-advanced.module';
import { HrModule } from './hr/hr.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { EnrollmentModule } from './enrollment/enrollment.module';
import { EnrolmentAdvancedModule } from './enrolment-advanced/enrolment-advanced.module';
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
import { BehaviourAdvancedModule } from './behaviour-advanced/behaviour-advanced.module';
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
import { SubstitutesModule } from './substitutes/substitutes.module';
import { EventsModule } from './events/events.module';
import { SisAdvancedModule } from './sis-advanced/sis-advanced.module';
import { SisGraduationModule } from './sis-graduation/sis-graduation.module';
import { SisTranscriptsModule } from './sis-transcripts/sis-transcripts.module';
import { CommunicationsAdvancedModule } from './communications-advanced/communications-advanced.module';
import { CrmModule } from './crm/crm.module';
import { OpsModule } from './ops/ops.module';
import { CommunityModule } from './community/community.module';
import { AlumniModule } from './alumni/alumni.module';
import { AccreditationModule } from './accreditation/accreditation.module';
import { EngagementModule } from './engagement/engagement.module';
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
    ClassroomAdvancedModule,
    HrModule,
    SchedulingModule,
    EnrollmentModule,
    EnrolmentAdvancedModule,
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
    BehaviourAdvancedModule,
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
    // Phase 2 Cycle 9 sub-cycle a — Sub Marketplace (M82). Platform-
    // portable substitute profiles (extended from the ADR-014 forward-
    // compat skeleton with grade_levels TEXT[] GIN-indexed +
    // overall_rating + total_assignments) with credential verification +
    // multi-shape availability (RECURRING / SPECIFIC / BLOCKED) + per-
    // school preferences. Tenant school pool, job postings with tier-1
    // POOL fan-out fired inline by JobPostingService.post (tier-2
    // MARKETPLACE escalation worker is P2-9b), bidirectional ratings
    // + session notes + EXCLUDE-gist pay rates + cancellation policies
    // are all in schema (migrations 132 + 133) but the request-path
    // surface is split across P2-9a (this commit, profile + pool +
    // jobs + accept/decline + sub.job.posted + sub.assignment.confirmed
    // outbox emits) and P2-9b (assignments lifecycle + ratings + session
    // notes + pay rate computation + cancellation policy worker).
    SubstitutesModule,
    // Phase 2 Cycle 12 — M101 Events & Ticketing. Atomic ticket sales
    // (UPDATE WHERE quantity_sold + qty <= quantity, never SELECT-
    // then-UPDATE), atomic gate scanning (UPDATE WHERE
    // qr_code_token AND status='VALID'), pending-order expiry sweep
    // with tier quantity_sold rollback, season passes with events-
    // included gate check, comp lists by type, event volunteer
    // sign-up, refunds with Stripe stub + GL revenue emit on event
    // completion.
    EventsModule,
    // Phase 2 Cycle 13 sub-cycle a — M20 SIS Advanced. Student profiles
    // with avatar approval (student-owned bio + interests + avatar
    // upload, homeroom-teacher review keystone). School-defined typed
    // custom fields attached to any SIS entity (STUDENT / STAFF /
    // GUARDIAN / CLASS) without schema changes. Parent-initiated info
    // update requests with configurable auto-approval against low-risk
    // fields. Student notes extended with ADMINISTRATIVE and
    // CONFIDENTIAL types — service-layer row scope on CONFIDENTIAL
    // rows. Family relationships (DIVORCED / JOINT custody etc.)
    // driving downstream parent data visibility.
    SisAdvancedModule,
    SisGraduationModule,
    // P2-13c — Transcripts (frozen course snapshot at generation
    // time — never live-joined to cls_grades), transfer records,
    // locker management with AES-256-GCM encrypted combinations and
    // year-end bulk-clear, reporting periods with strict UPCOMING ->
    // OPEN -> GRADING_CLOSED -> PUBLISHED transition graph, student
    // awards including bulk-honor-roll, medical exemption records.
    SisTranscriptsModule,
    // P2-19a — Communications Advanced (translation + templates +
    // broadcast analytics). Cached AI translation keyed on
    // UNIQUE(message_id, target_language), reusable templates with
    // render-time required-variable validation, broadcast segments
    // with 6-type resolution, and per-(broadcast, segment) delivery
    // funnel analytics. Two Kafka consumers: TranslationConsumer on
    // msg.message.posted (auto-translate for recipients with
    // auto_translate_incoming=true) and BroadcastAnalyticsConsumer
    // on msg.broadcast.delivered.
    CommunicationsAdvancedModule,
    // Phase 2 Cycle 21 sub-cycle a — M90 CRM. Internal-only customer-
    // management surface for CampusOS-the-company. Platform-scoped:
    // routes under /api/v1/internal/crm/* skip the tenant subdomain
    // requirement and resolve permissions against the PLATFORM IAM
    // scope. 9 platform tables (crm_accounts ... crm_invoices), 5
    // services, ~22 endpoints, 1 weekly health-score worker.
    CrmModule,
    // Phase 2 Cycle 21 sub-cycle b — M91 Internal Ops + Platform
    // Pricing. CampusOS-the-company employee management, FERPA/GDPR-
    // audited tenant access grants with hard 4-hour maximum +
    // mandatory >=20-char justification, internal cross-team
    // tickets, pricing bands + history + support tier definitions.
    // Platform-scoped (no tenant header). 9 platform tables, 5
    // services + 1 controller + 1 worker + ~20 endpoints. Emits
    // ops.tenant_access.granted on grant. TenantAccessExpiryWorker
    // sweeps expired grants every 5 min.
    OpsModule,
    // Phase 2 Cycle 21 sub-cycle c — Community Exchange (M90+). Cross-
    // school marketplace + community profiles + ratings + unified
    // tsvector full-text search. Tenant-scoped (regular guard chain).
    // 8 platform tables, 6 services + 1 controller + 2 Kafka consumers
    // + ~22 endpoints. Parents are blocked from listing creation at
    // the service layer per ADR-073. Emits mkt.listing.published +
    // mkt.transaction.completed.
    CommunityModule,
    // Phase 2 Cycle 22 — M102 Alumni (Wave D Module Completion).
    // Self-maintained alumni profiles (ADR-019, ADR-055 identity)
    // with opt-in directory + tag segmentation. Multi-currency
    // fundraising campaigns with Redis-cached raised totals (TTL
    // 5min). Campaign recipient outreach funnel (PENDING -> SENT ->
    // OPENED -> RESPONDED -> DONATED). Alumni news feed, reunion
    // groups, alumni events with optional P2-12 Events linkage —
    // evt_event_id is a DISPLAY-ONLY soft reference with graceful
    // fallback to rsvp_url. 8 services, 1 controller, ~28 endpoints,
    // 2 Kafka emits (alm.campaign.activated, alm.donation.received).
    AlumniModule,
    // P2-23a — Accreditation. M85 platform-seeded frameworks
    // (AdvancED, IB MYP, CIS) + per-school adoption with custom
    // framework support. Standard-by-standard evidence collection
    // (5 types: DOCUMENT/URL/METRIC/OBSERVATION/SURVEY) with
    // approval workflow. Self-study ratings (4 values, UNIQUE per
    // standard/school/cycle). Improvement action plans with JSONB
    // sub-actions and ActionPlanOverdueWorker nightly sweep that
    // emits acc.action_plan.overdue via durable outbox. Site visit
    // preparation with auto-computed readiness_score (% of adopted
    // standards with both rating + APPROVED evidence). 5 services,
    // 1 controller, ~22 endpoints, 1 Kafka emit
    // (acc.action_plan.overdue), 1 background worker
    // (ActionPlanOverdueWorker).
    AccreditationModule,

    // P2-24 — Parent Engagement (M100). Conference scheduling
    // (ATOMIC slot booking pattern), engagement scoring from 5
    // cross-module sources (attendance, communications, conferences,
    // volunteering, payments) with per-school configurable weights,
    // and anonymous parent surveys with aggregated-only results.
    // 5 services + 1 controller + 2 background workers + ~24
    // endpoints + 2 Kafka emits (eng.conference.booking_open,
    // eng.survey.opened).
    EngagementModule,
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
