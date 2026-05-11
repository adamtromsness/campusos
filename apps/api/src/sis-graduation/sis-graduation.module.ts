import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { OutboxService } from '../kafka/outbox.service';
import { GraduationService } from './graduation.service';
import { GraduationAuditWorker } from './graduation-audit.worker';
import { GpaService } from './gpa.service';
import { GpaWorker } from './gpa.worker';
import { ServiceLearningService } from './service-learning.service';
import { PrerequisiteService } from './prerequisite.service';
import { SisGraduationController } from './sis-graduation.controller';

/**
 * SIS Graduation Module — Phase 2 Cycle 13 sub-cycle b (P2-13b).
 *
 * Ships 4 services + 2 workers + 1 controller + ~20 endpoints +
 * 1 Kafka emit (sis.graduation.at_risk) under STU-005.
 *
 * Three structural keystones:
 *   1. GRADUATION AUDIT WORKER — nightly walk of every active student in
 *      the school; per requirement computes MET / IN_PROGRESS / NOT_MET
 *      against cls_grades + sis_service_learning_hours + sis_student_gpa_snapshots.
 *      Emits sis.graduation.at_risk per senior with NOT_MET requirements;
 *      deterministic event_id keyed on (studentId, runId).
 *   2. GPA WORKER — end-of-term recompute of cumulative + term GPA per
 *      student under the school's default GPA configuration. Applies
 *      honors_weight_bonus + ap_weight_bonus when calculation_method =
 *      WEIGHTED. Class rank computed within (school, grade_level).
 *   3. COURSE PREREQUISITE VALIDATION — pre-flight check the course
 *      enrolment flow can hit before INSERTing into sis_enrollments.
 *      Compares the student's best published grade on the prerequisite
 *      course against min_grade using the GRADE_RANK ordering.
 *
 * Permission codes (STU-005 already in catalogue from P2-13b):
 *   - STU-005:read — every persona for their visibility scope.
 *   - STU-005:write — staff / admin for service-hours approval +
 *     submitting on behalf; STUDENT for self-service hour submission.
 *   - STU-005:admin — requirement CRUD + GPA config CRUD + grade scale
 *     CRUD + worker triggers.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    OutboxService,
    GraduationService,
    GraduationAuditWorker,
    GpaService,
    GpaWorker,
    ServiceLearningService,
    PrerequisiteService,
  ],
  controllers: [SisGraduationController],
  exports: [
    GraduationService,
    GraduationAuditWorker,
    GpaService,
    GpaWorker,
    ServiceLearningService,
    PrerequisiteService,
  ],
})
export class SisGraduationModule {}
