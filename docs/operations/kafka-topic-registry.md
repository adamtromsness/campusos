# Kafka Topic Registry

**Source of truth for every topic emitted or consumed by CampusOS.** Generated
P2-H3 Step 4 of the post-Phase-2 hardening cycle.

## Event Classification

Per the hardening plan, every event belongs to exactly one of four classes:

| Class            | Definition                                                                                                                                                   | Producer delivery                                                                                                                                                          | Consumer retry                                                 | DLQ policy                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **COMMAND**      | A request for another module to do something. Failure to deliver is a correctness bug. Always carries `payload.sourceRefId` and is idempotent on redelivery. | Outbox (durable)                                                                                                                                                           | Retry up to 5 with backoff. Park to DLQ.                       | SRE pages within 15 min for financial / safety events; 60 min otherwise. |
| **NOTIFICATION** | A user-facing alert / message. Failure to deliver may degrade UX but never corrupts state.                                                                   | Outbox (durable) for safety alerts (SHI, banned-person, breach). Best-effort `KafkaProducerService.emit` for routine UX (announcements, message-posted, attendance tardy). | Retry up to 3 with backoff. Drop after MAX_HANDLER_ATTEMPTS=5. | Daily review only — DLQ alarm is INFO-class.                             |
| **OBSERVABLE**   | A read-side fact recorded so analytics + dashboards can react. Loss is acceptable if rare; downstream batch jobs reconcile.                                  | Best-effort `KafkaProducerService.emit`.                                                                                                                                   | Retry once, drop on second failure.                            | Daily review only.                                                       |
| **FUTURE**       | Topic name appears in handoff docs or auto-task rules but no producer ships yet. Phase 3 wiring.                                                             | No producer.                                                                                                                                                               | Consumer (if any) idle.                                        | n/a.                                                                     |

## Topic Registry

The canonical wire topic is `<env>.<topic>` (e.g. `dev.pay.payment.received`).
The env prefix is applied by `prefixedTopic()` from
`apps/api/src/kafka/event-envelope.ts`. All Kafka tools, monitoring, runbooks,
and consumer subscriptions use the wire form. The "Topic" column below shows
the un-prefixed canonical name as it appears in `KafkaProducerService.emit({
topic: ... })` calls and in consumer `subscribe()` calls.

### M0 Platform Foundation

| Topic                          | Class      | Producer                                  | Consumers |
| ------------------------------ | ---------- | ----------------------------------------- | --------- |
| `iam.child.linked`             | OBSERVABLE | Cycle 6.1 ChildLinkRequestService.approve | none      |
| `iam.household.member_changed` | OBSERVABLE | Cycle 6.1 HouseholdsService               | none      |

### M20 SIS Core (Cycle 1)

| Topic                       | Class        | Producer                      | Consumers                           |
| --------------------------- | ------------ | ----------------------------- | ----------------------------------- |
| `att.attendance.marked`     | OBSERVABLE   | AttendanceService.batchSubmit | (M110 SISReadModelWorker — Phase 2) |
| `att.attendance.confirmed`  | OBSERVABLE   | AttendanceService.batchSubmit | (M110 SISReadModelWorker — Phase 2) |
| `att.student.marked_tardy`  | NOTIFICATION | AttendanceService.batchSubmit | AttendanceNotificationConsumer      |
| `att.student.marked_absent` | NOTIFICATION | AttendanceService.batchSubmit | AttendanceNotificationConsumer      |
| `att.absence.requested`     | NOTIFICATION | AbsenceRequestService.submit  | AbsenceRequestNotificationConsumer  |
| `att.absence.reviewed`      | NOTIFICATION | AbsenceRequestService.review  | AbsenceRequestNotificationConsumer  |

### M21 Classroom (Cycle 2)

| Topic                         | Class        | Producer                                       | Consumers                                                  |
| ----------------------------- | ------------ | ---------------------------------------------- | ---------------------------------------------------------- |
| `cls.assignment.posted`       | COMMAND      | AssignmentService.create + .update             | Cycle 7 TaskWorker (auto-task rules)                       |
| `cls.submission.submitted`    | OBSERVABLE   | SubmissionService.upsert                       | none                                                       |
| `cls.grade.published`         | NOTIFICATION | GradeService.publish + .batchPublish           | Cycle 3 GradeNotificationConsumer, GradebookSnapshotWorker |
| `cls.grade.unpublished`       | NOTIFICATION | GradeService.unpublish                         | GradebookSnapshotWorker                                    |
| `cls.progress_note.published` | NOTIFICATION | ProgressNoteService.upsert (published_at flip) | Cycle 3 ProgressNoteNotificationConsumer                   |
| `cls.hall_pass.issued`        | NOTIFICATION | (P2C7 ClassroomAdvanced HallPassService)       | none                                                       |
| `cls.hall_pass.overdue`       | NOTIFICATION | (P2C7 ClassroomAdvanced HallPassOverdueWorker) | none                                                       |

### M40 Communications (Cycle 3 + 14)

| Topic                        | Class                         | Producer                                                                     | Consumers                                                |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `msg.message.posted`         | NOTIFICATION                  | MessageService.post (durable outbox per P2-H3 Step 2)                        | Cycle 3 MessageNotificationConsumer, ThreadStatsConsumer |
| `msg.announcement.published` | NOTIFICATION                  | AnnouncementService.publish                                                  | AudienceFanOutWorker                                     |
| `msg.emergency.issued`       | NOTIFICATION (safety, outbox) | EmergencyAlertService.issue (P2-H3 Step 2 candidate — currently best-effort) | (Cycle 14 emergency-alert consumer — Phase 2)            |
| `inc.emergency.declared`     | NOTIFICATION (safety)         | (P2C2 Incident Emergency module)                                             | none                                                     |
| `inc.incident.reported`      | NOTIFICATION                  | (P2C2 Incident Emergency module)                                             | none                                                     |

### M80 HR/Workforce (Cycle 4)

| Topic                       | Class        | Producer                                                    | Consumers                                   |
| --------------------------- | ------------ | ----------------------------------------------------------- | ------------------------------------------- |
| `hr.leave.requested`        | NOTIFICATION | LeaveService.submit                                         | LeaveNotificationConsumer                   |
| `hr.leave.approved`         | COMMAND      | LeaveService.approve (durable via outbox per REVIEW-CYCLE4) | LeaveNotificationConsumer, CoverageConsumer |
| `hr.leave.rejected`         | NOTIFICATION | LeaveService.reject                                         | LeaveNotificationConsumer                   |
| `hr.leave.cancelled`        | NOTIFICATION | LeaveService.cancel                                         | LeaveNotificationConsumer                   |
| `hr.leave.coverage_needed`  | COMMAND      | LeaveNotificationConsumer republish                         | CoverageConsumer                            |
| `hr.certification.verified` | OBSERVABLE   | CertificationService.verify                                 | none                                        |
| `hr.payroll.processed`      | COMMAND      | PayrollService.markPaid (durable outbox per P2-4a)          | GLConsumer                                  |
| `hr.training.completed`     | COMMAND      | TrainingService.markCompleted (durable outbox per P2-4c)    | CertificationService.autoIssue              |
| `hr.job.posted`             | OBSERVABLE   | JobPostingService.publish                                   | none                                        |
| `hr.offer.accepted`         | COMMAND      | OfferService.respond (durable outbox per P2-4b)             | (HR onboarding worker — Phase 2)            |

### M22 Scheduling (Cycle 5)

| Topic                   | Class        | Producer                          | Consumers                        |
| ----------------------- | ------------ | --------------------------------- | -------------------------------- |
| `sch.timetable.updated` | OBSERVABLE   | TimetableService.create + .update | none                             |
| `sch.coverage.needed`   | OBSERVABLE   | CoverageConsumer                  | none                             |
| `sch.coverage.assigned` | NOTIFICATION | CoverageService.assign            | (notification fan-out — Phase 2) |

### M81 Enrollment (Cycle 6)

| Topic                            | Class        | Producer                                                      | Consumers            |
| -------------------------------- | ------------ | ------------------------------------------------------------- | -------------------- |
| `enr.application.submitted`      | OBSERVABLE   | ApplicationService.create                                     | none                 |
| `enr.application.status_changed` | OBSERVABLE   | ApplicationService.patchStatus                                | none                 |
| `enr.offer.issued`               | NOTIFICATION | OfferService.issue                                            | none                 |
| `enr.offer.responded`            | OBSERVABLE   | OfferService.respond                                          | none                 |
| `enr.student.enrolled`           | COMMAND      | OfferService.respond ACCEPT (durable outbox per P2-H3 Step 2) | PaymentAccountWorker |
| `enr.student.withdrawn`          | COMMAND      | (P2C5 Enrolment Advanced WithdrawalService)                   | none                 |
| `enr.student.onboarded`          | COMMAND      | OnboardingService.completeTask                                | none                 |
| `enr.tour.booked`                | NOTIFICATION | (P2C5 Enrolment Advanced TourBookingService)                  | none                 |

### M84 Family Billing (Cycle 6)

| Topic                    | Class        | Producer                                                | Consumers                                   |
| ------------------------ | ------------ | ------------------------------------------------------- | ------------------------------------------- |
| `pay.invoice.created`    | COMMAND      | InvoiceService.send (durable outbox per P2-H3 Step 2)   | GLConsumer, GlReconciliationWorker (audit)  |
| `pay.payment.received`   | COMMAND      | PaymentService.pay (durable outbox per P2-H3 Step 2)    | GLConsumer, GlReconciliationWorker (audit)  |
| `pay.refund.issued`      | COMMAND      | RefundService.issue (durable outbox per P2-H3 Step 2)   | GLConsumer, GlReconciliationWorker (audit)  |
| `pay.debt.written_off`   | COMMAND      | InvoiceService.cancel (durable outbox per P2-H3 Step 1) | (GLConsumer write-off leg — Phase 2 wiring) |
| `pay.credit_note.issued` | COMMAND      | (P2C6 PaymentsAdvanced CreditNoteService)               | GLConsumer, GlReconciliationWorker (audit)  |
| `pay.payment.reversed`   | COMMAND      | (P2C6 PaymentsAdvanced ReversalService)                 | GLConsumer, GlReconciliationWorker (audit)  |
| `pay.lunch.low_balance`  | NOTIFICATION | (P2C6 PaymentsAdvanced LunchAccountService)             | none                                        |

### M83 Finance & Accounting (Cycle 26)

| Topic                               | Class            | Producer                                                 | Consumers                              |
| ----------------------------------- | ---------------- | -------------------------------------------------------- | -------------------------------------- |
| `fin.budget_transfer.approved`      | OBSERVABLE       | (P2C29 BudgetTransferService)                            | none                                   |
| `fin.journal_batch.posted`          | COMMAND          | JournalBatchService.post (durable outbox)                | JournalBatchPostedConsumer             |
| `fin.gl_reconciliation.discrepancy` | COMMAND (safety) | GlReconciliationWorker (durable outbox per P2-H3 Step 3) | (SRE alerts pipeline — Phase 2 wiring) |

### M1 Tasks / M2 Workflows (Cycle 7)

| Topic                               | Class        | Producer                               | Consumers                        |
| ----------------------------------- | ------------ | -------------------------------------- | -------------------------------- |
| `task.created`                      | OBSERVABLE   | TaskWorker (auto-task creation)        | none                             |
| `task.completed`                    | OBSERVABLE   | TaskService.markCompleted              | none                             |
| `student.acknowledgement.completed` | OBSERVABLE   | AcknowledgementService.acknowledge     | none                             |
| `approval.step.awaiting`            | NOTIFICATION | WorkflowEngineService.submit + advance | (notification fan-out — Phase 2) |
| `approval.request.resolved`         | COMMAND      | WorkflowEngineService.finalise         | LeaveApprovalConsumer            |

### M60 Service Tickets (Cycle 8)

| Topic                  | Class        | Producer                                            | Consumers                                                |
| ---------------------- | ------------ | --------------------------------------------------- | -------------------------------------------------------- |
| `tkt.ticket.submitted` | NOTIFICATION | TicketService.create                                | TicketNotificationConsumer, TaskWorker                   |
| `tkt.ticket.assigned`  | NOTIFICATION | TicketService.assign + .reassign                    | TicketNotificationConsumer, TaskWorker                   |
| `tkt.ticket.commented` | NOTIFICATION | CommentService.post                                 | TicketNotificationConsumer                               |
| `tkt.ticket.resolved`  | NOTIFICATION | TicketService.resolve + ProblemService.resolveBatch | TicketNotificationConsumer, TicketTaskCompletionConsumer |

### M20 Behaviour (Cycle 9)

| Topic                                     | Class                                 | Producer                                            | Consumers                                 |
| ----------------------------------------- | ------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| `beh.incident.reported`                   | NOTIFICATION                          | IncidentService.report                              | BehaviourNotificationConsumer, TaskWorker |
| `beh.incident.resolved`                   | NOTIFICATION                          | IncidentService.resolve                             | BehaviourNotificationConsumer             |
| `beh.action.parent_notification_required` | NOTIFICATION                          | ActionService.create                                | BehaviourNotificationConsumer             |
| `beh.bip.feedback_requested`              | NOTIFICATION                          | FeedbackService.request                             | BehaviourNotificationConsumer, TaskWorker |
| `beh.positive_points.awarded`             | OBSERVABLE (durable outbox per P2-H1) | (P2C14 BehaviourAdvanced PositiveBehaviourService)  | none                                      |
| `beh.rj_conference.resolved`              | OBSERVABLE                            | (P2C14 BehaviourAdvanced RestorativeJusticeService) | none                                      |

### M23 Health & Wellness (Cycle 10)

| Topic                            | Class                                     | Producer                                                              | Consumers                                |
| -------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| `hlth.medication.administered`   | OBSERVABLE                                | AdministrationService.administer                                      | none                                     |
| `hlth.nurse_visit.sent_home`     | NOTIFICATION (safety)                     | NurseVisitService.update sent_home flip                               | none                                     |
| `iep.accommodation.updated`      | COMMAND (durable outbox per P2-H3 Step 2) | IepPlanService.create + patch + accommodation mutations               | IepAccommodationConsumer                 |
| `hlth.immunisation.noncompliant` | NOTIFICATION                              | (P2C3 HealthAdvanced ImmunisationComplianceService)                   | none                                     |
| `hlth.allergy_alert.changed`     | COMMAND                                   | HealthRecordService.create + .update allergy mutations (P2-H3 Step 1) | (FDS allergen consumer — Phase 2 wiring) |

### M27 Counselling & Student Services (Cycle 11 + 11.1)

| Topic                         | Class                                           | Producer                         | Consumers                        |
| ----------------------------- | ----------------------------------------------- | -------------------------------- | -------------------------------- |
| `svc.referral.created`        | NOTIFICATION                                    | ReferralService.submit           | (notification fan-out — Phase 2) |
| `svc.referral.escalated`      | NOTIFICATION (safety, durable outbox per P2C28) | (P2C28 CrisisEscalationService)  | none                             |
| `svc.tier.changed`            | OBSERVABLE                                      | MtssTierService.set              | none                             |
| `svc.wellbeing.alert.created` | NOTIFICATION (safety, durable outbox per P2-H1) | CheckinService.submit alert eval | (notification fan-out — Phase 2) |

### M24 Library (Cycle 12)

| Topic             | Class        | Producer                                    | Consumers |
| ----------------- | ------------ | ------------------------------------------- | --------- |
| `lib.fine.issued` | NOTIFICATION | CheckoutService.returnCheckout overdue path | none      |

### M66 Athletics (Cycle 13)

| Topic                                         | Class                             | Producer                                     | Consumers                                          |
| --------------------------------------------- | --------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| `ath.game.completed`                          | OBSERVABLE                        | ResultService.enterResult (P2-H3 Step 1)     | AthleticsReadModelWorker, OfficialsReadModelWorker |
| `ath.game.result.entered`                     | NOTIFICATION                      | ResultService.enterResult                    | (notification fan-out — Phase 2)                   |
| `ath.equipment.replacement_charge`            | COMMAND (durable outbox per P2C8) | EquipmentService.returnCheckout DAMAGED/LOST | none                                               |
| `ath.highlight_clip.portfolio_link_requested` | COMMAND (durable outbox per P2C8) | GameStreamService.addClipToPortfolio         | none                                               |

### M101 Events & Ticketing (Cycle 12)

| Topic                        | Class                                       | Producer                            | Consumers  |
| ---------------------------- | ------------------------------------------- | ----------------------------------- | ---------- |
| `evt.order.confirmed`        | COMMAND (durable outbox per REVIEW-CYCLE12) | OrderService.purchase               | none       |
| `evt.event.completed`        | COMMAND (durable outbox per REVIEW-CYCLE12) | EventService.complete               | GLConsumer |
| `evt.refund.issued`          | COMMAND (durable outbox per REVIEW-CYCLE12) | RefundService.issue                 | GLConsumer |
| `evt.athletic_event.created` | COMMAND (durable outbox per REVIEW-CYCLE12) | EventService.create athletic branch | none       |

### M64 Clubs & Student Life (Cycle 17)

| Topic                            | Class        | Producer                | Consumers |
| -------------------------------- | ------------ | ----------------------- | --------- |
| `ext.consent.received`           | NOTIFICATION | (P2C17 ConsentService)  | none      |
| `ext.election.results.published` | OBSERVABLE   | (P2C17 ElectionService) | none      |

### M103 Groups & Communities (Cycle 18)

| Topic                     | Class        | Producer                      | Consumers |
| ------------------------- | ------------ | ----------------------------- | --------- |
| `grp.announcement.posted` | NOTIFICATION | GroupAnnouncementService.post | none      |
| `grp.event.created`       | NOTIFICATION | GroupEventService.create      | none      |

### M61 Transportation (Cycle 19)

| Topic                                | Class                 | Producer                                              | Consumers |
| ------------------------------------ | --------------------- | ----------------------------------------------------- | --------- |
| `trn.no_show.detected`               | NOTIFICATION (safety) | NoShowService.runOnce                                 | none      |
| `trn.delay.reported`                 | NOTIFICATION          | (P2C19 DelayReportService)                            | none      |
| `trn.parts.low`                      | OBSERVABLE            | (P2C11 TransportationAdvanced PartsService)           | none      |
| `trn.driver.hours_approaching_limit` | NOTIFICATION (safety) | (P2C11 TransportationAdvanced DriverHoursService)     | none      |
| `trn.generation.completed`           | OBSERVABLE            | (P2C11 TransportationAdvanced RouteGenerationService) | none      |

### M63 Food Service (Cycle 20)

| Topic               | Class        | Producer                                                                      | Consumers                                                         |
| ------------------- | ------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `fds.meal.served`   | OBSERVABLE   | PosService.transact (renamed from fds.transaction.completed per P2-H3 Step 1) | LunchAccountConsumer (debits balance), FoodServiceReadModelWorker |
| `fds.inventory.low` | NOTIFICATION | (P2C10 FoodServiceAdvanced InventoryService)                                  | none                                                              |

### M65 Facilities (Cycle 21)

| Topic                              | Class                 | Producer                                          | Consumers |
| ---------------------------------- | --------------------- | ------------------------------------------------- | --------- |
| `fac.work_order.created`           | NOTIFICATION          | WorkOrderService.create                           | none      |
| `fac.supply.reorder_needed`        | NOTIFICATION          | SupplyService.adjust threshold-cross              | none      |
| `fac.route_stop.issue_noted`       | NOTIFICATION          | (P2C18 FacilitiesAdvanced CleaningRouteService)   | none      |
| `fac.fire_drill.overdue`           | NOTIFICATION (safety) | (P2C18 FacilitiesAdvanced FireDrillService)       | none      |
| `fac.inspection.failed`            | NOTIFICATION (safety) | InspectionService.create FAIL                     | none      |
| `fac.inspection_violation.overdue` | NOTIFICATION (safety) | (P2C18 FacilitiesAdvanced ViolationService)       | none      |
| `fac.maintenance_task.overdue`     | NOTIFICATION          | (P2C18 FacilitiesAdvanced MaintenanceTaskService) | none      |

### M62 IT Infrastructure (Cycle 22)

| Topic                        | Class                 | Producer                                  | Consumers |
| ---------------------------- | --------------------- | ----------------------------------------- | --------- |
| `tech.licence.near_capacity` | NOTIFICATION          | LicenceService.assignSeat threshold-cross | none      |
| `tech.usage.flagged`         | NOTIFICATION (safety) | (P2C20 ITAdvanced DeviceUsageService)     | none      |
| `tech.monitoring.alert`      | NOTIFICATION (safety) | (P2C20 ITAdvanced MonitoringService)      | none      |
| `tech.remote_action.issued`  | OBSERVABLE            | (P2C20 ITAdvanced RemoteActionService)    | none      |

### M85 Accreditation (Cycle 23)

| Topic                     | Class        | Producer                | Consumers |
| ------------------------- | ------------ | ----------------------- | --------- |
| `acc.action_plan.overdue` | NOTIFICATION | ActionPlanOverdueWorker | none      |

### M26 Portfolio (Cycle 24)

| Topic                     | Class        | Producer                 | Consumers |
| ------------------------- | ------------ | ------------------------ | --------- |
| `pfl.achievement.awarded` | NOTIFICATION | AchievementService.award | none      |

### M25 Publications (Cycle 25)

| Topic                       | Class        | Producer                       | Consumers                        |
| --------------------------- | ------------ | ------------------------------ | -------------------------------- |
| `pub.publication.published` | NOTIFICATION | DistributionService.distribute | (notification fan-out — Phase 2) |

### M86 Procurement (Cycle 27)

| Topic                        | Class      | Producer                   | Consumers                               |
| ---------------------------- | ---------- | -------------------------- | --------------------------------------- |
| `prc.requisition.submitted`  | OBSERVABLE | RequisitionService.submit  | none                                    |
| `prc.distribution.completed` | OBSERVABLE | DistributionService.create | (8 module-specific consumers — Phase 2) |

### M67 School Store (Cycle 28)

| Topic                          | Class        | Producer                                | Consumers                               |
| ------------------------------ | ------------ | --------------------------------------- | --------------------------------------- |
| `str.order.completed`          | OBSERVABLE   | OrderService approval flip + fulfilment | (M84 family-billing consumer — Phase 2) |
| `str.inventory.reorder_needed` | NOTIFICATION | InventoryService.adjust threshold-cross | (M86 procurement consumer — Phase 2)    |
| `str.promotion.code_redeemed`  | OBSERVABLE   | PromotionService.redeem                 | none                                    |
| `str.price.scheduled_applied`  | OBSERVABLE   | PriceScheduleWorker                     | none                                    |
| `str.gift_card.depleted`       | OBSERVABLE   | GiftCardService.redeem balance-zero     | none                                    |

### M120 Data Governance (Cycle 30)

| Topic                   | Class                                      | Producer              | Consumers                          |
| ----------------------- | ------------------------------------------ | --------------------- | ---------------------------------- |
| `dpo.breach.discovered` | COMMAND (safety, durable outbox per P2-H1) | BreachService.declare | (TaskWorker URGENT 72h escalation) |

### M62 IT Infrastructure (Cycle 31 Observability)

| Topic                  | Class      | Producer                                        | Consumers               |
| ---------------------- | ---------- | ----------------------------------------------- | ----------------------- |
| `video.uploaded`       | OBSERVABLE | (P2C7 ClassroomAdvanced LessonRecordingService) | VideoTranscriptConsumer |
| `lesson.summary.ready` | OBSERVABLE | (P2C7 ClassroomAdvanced LessonSummaryConsumer)  | LessonSummaryConsumer   |

### M82 Sub Marketplace (Cycle 9)

| Topic                           | Class                 | Producer                                   | Consumers                  |
| ------------------------------- | --------------------- | ------------------------------------------ | -------------------------- |
| `sub.job.posted`                | NOTIFICATION          | (P2C9 SubMarketplace JobPostingService)    | none                       |
| `sub.job.escalated`             | NOTIFICATION          | (P2C9 SubMarketplace JobEscalationService) | none                       |
| `sub.assignment.confirmed`      | NOTIFICATION          | (P2C9 SubMarketplace AssignmentService)    | CoverArrangementConsumer   |
| `sub.assignment.late_cancelled` | NOTIFICATION (safety) | (P2C9 SubMarketplace AssignmentService)    | CancellationPolicyConsumer |

### M93 Visitor Management (P2C1)

| Topic                        | Class                 | Producer                           | Consumers             |
| ---------------------------- | --------------------- | ---------------------------------- | --------------------- |
| `vis.visitor.signed_in`      | OBSERVABLE            | VisitorService.signIn              | none                  |
| `vis.banned_person.detected` | NOTIFICATION (safety) | VisitorService.signIn check_banned | none                  |
| `vis.muster.created`         | OBSERVABLE            | MusterService.create               | VisitorMusterConsumer |

### M40 Alumni (P2C22)

| Topic                    | Class        | Producer                      | Consumers |
| ------------------------ | ------------ | ----------------------------- | --------- |
| `alm.campaign.activated` | NOTIFICATION | (P2C22 AlumniCampaignService) | none      |
| `alm.donation.received`  | OBSERVABLE   | (P2C22 AlumniDonationService) | none      |

### M100 Parent Engagement (P2C24)

| Topic                         | Class        | Producer                       | Consumers |
| ----------------------------- | ------------ | ------------------------------ | --------- |
| `eng.conference.booking_open` | NOTIFICATION | (P2C24 ConferenceStatusWorker) | none      |
| `eng.survey.opened`           | NOTIFICATION | (P2C24 ParentSurveyService)    | none      |

### M91 Internal Operations (Cycle 21 + P2C21)

| Topic                           | Class        | Producer                     | Consumers |
| ------------------------------- | ------------ | ---------------------------- | --------- |
| `crm.account.lifecycle_changed` | OBSERVABLE   | (P2C21 CRM AccountService)   | none      |
| `cur.delivery_gap.detected`     | NOTIFICATION | (Cycle 23 CurriculumService) | none      |

### Test / Dev

| Topic      | Class      | Producer          | Consumers |
| ---------- | ---------- | ----------------- | --------- |
| `dev.test` | OBSERVABLE | (smoke test only) | none      |

## Naming Convention

- Lower-case, dot-separated, three or four tokens.
- Format: `<module-prefix>.<noun>.<verb>` or `<module-prefix>.<sub-noun>.<noun>.<verb>`.
- Verbs are past-tense facts (`marked_tardy`, `confirmed`, `published`) or imperative request triggers (`coverage_needed`, `payment_received`).
- The env prefix (`dev.` / `staging.` / `prod.`) is applied by `prefixedTopic()`
  at the producer + consumer boundary — services never hard-code it.

## P2-H3 Step 4 Audit Notes

The audit flagged `cls.grade.posted` as a name inconsistency. Verified: no
producer or consumer references that string. The single occurrence was a stale
doc comment in `analytics/workers.service.ts` line 81 (now fixed to read
`cls.grade.published`). The canonical topic name is `cls.grade.published`.

Auto-task rules in `tsk_auto_task_rules` are tenant-seeded and are not bound
to producer-less topics in `seed-tasks.ts` — every rule's `trigger_event_type`
matches a producer in this registry as of P2-H3.
