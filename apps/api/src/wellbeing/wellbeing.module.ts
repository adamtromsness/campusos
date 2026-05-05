import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { SurveyTemplateService } from './survey-template.service';
import { SurveyTemplateController } from './survey-template.controller';
import { DeploymentService } from './deployment.service';
import { DeploymentController } from './deployment.controller';
import { CheckinService } from './checkin.service';
import { CheckinController } from './checkin.controller';
import { AlertService } from './alert.service';
import { AlertController } from './alert.controller';

/**
 * Wellbeing Module — Cycle 11.1 Step 4.
 *
 * Wires the M27 Student Services Domain 5 schema (Step 1 + Step 2
 * migrations, Step 3 seed) into a request-path API surface. Step 4
 * lands two services + ~13 endpoints under the /counselling/wellbeing
 * URL prefix:
 *
 *   - SurveyTemplateService   — svc_wellbeing_survey_templates +
 *                               svc_wellbeing_questions CRUD with the
 *                               UNIQUE(school_id, name) keystone catch.
 *                               Counsellor or admin only at the service
 *                               layer (cou-004:write held by Staff +
 *                               Admin per the Step 3 IAM grants).
 *                               Templates are deactivated rather than
 *                               hard-deleted once they have associated
 *                               deployments — the schema NO ACTION FK
 *                               is the safety net.
 *   - DeploymentService       — svc_wellbeing_deployments CRUD with the
 *                               keystone activate endpoint that resolves
 *                               the target audience and bulk-INSERTs
 *                               svc_wellbeing_checkins rows for every
 *                               targeted student. Audience resolution
 *                               supports CASELOAD / SCHOOL / CLASS /
 *                               CUSTOM_LIST out of the box; YEAR_GROUP
 *                               is deferred (returns 400 with a clear
 *                               message). Status transitions
 *                               SCHEDULED to ACTIVE to COMPLETED with
 *                               CANCELLED reachable from any non-
 *                               terminal state. Locked-row UPDATE
 *                               pattern matches Cycle 11 conventions.
 *
 * Step 5 will add the student-facing CheckInService + AlertService
 * with the alert evaluation logic + svc.wellbeing.alert.created Kafka
 * emit. Step 6 lands the counsellor UI; Step 7 lands the first
 * student-input surface in CampusOS.
 *
 * Authorisation contract (per the Step 3 seed):
 *   - cou-004:read   — granted to Teacher (aggregated trends only —
 *                      future Step 5 service strips individual data),
 *                      Student (own check-ins + own responses),
 *                      Staff (full counsellor surface), Admin (school-
 *                      wide). Parents NOT granted — wellbeing data is
 *                      student-counsellor confidential.
 *   - cou-004:write  — Staff (counsellor) + Admin (everyFunction).
 *                      Creates templates, deploys, activates,
 *                      completes, cancels, and (Step 5) triages alerts.
 *   - cou-004:admin  — School Admin + Platform Admin via everyFunction.
 *                      Reserved for the Step 6 admin school-wide
 *                      analytics rollup that the counsellor dashboard
 *                      doesn't expose.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [SurveyTemplateService, DeploymentService, CheckinService, AlertService],
  controllers: [SurveyTemplateController, DeploymentController, CheckinController, AlertController],
  exports: [SurveyTemplateService, DeploymentService, CheckinService, AlertService],
})
export class WellbeingModule {}
