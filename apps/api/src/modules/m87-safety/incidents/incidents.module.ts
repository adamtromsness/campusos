import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { AccountabilityService } from '../reunification/accountability.service';
import { DeclarationOutboxWorker } from '../emergency/declaration-outbox.worker';
import { DrillService } from '../drills/drill.service';
import { IncidentService } from './incident.service';
import { IncidentTypeService } from './incident-type.service';
import { IncidentsController } from './incidents.controller';
import { NonDisciplineIncidentService } from './non-discipline.service';
import { ProcedureService } from '../emergency/procedure.service';
import { ReunificationService } from '../reunification/reunification.service';
import { TimelineService } from './timeline.service';

/**
 * Incident & Emergency Module — M91 (Phase 2 Cycle 2).
 *
 * 8 services + 1 controller + 1 background worker + 24 endpoints +
 * 2 Kafka emit topics (inc.emergency.declared, inc.incident.reported)
 * + 1 worker-emitted topic (inc.emergency.alert.dispatch).
 *
 * Three structural keystones:
 *   1. ATOMIC DECLARATION — IncidentService.declare writes
 *      inc_incidents + inc_declaration_outbox in one tenant tx; the
 *      outbox is the durable orchestrator for fan-out (tasks +
 *      muster + alerts) and is crash-recoverable.
 *   2. IMMUTABLE TIMELINE — TimelineService exposes only `append`
 *      and `listForIncident`; no PATCH and no DELETE. Service-side
 *      discipline per ADR-010.
 *   3. IDENTITY-VERIFIED REUNIFICATION — ReunificationService.create
 *      verifies released_to_id is a vis_visitors row currently
 *      signed in via vis_sign_ins; does not allow release otherwise.
 *
 * Permission gates per the catalogue:
 *   SAF-001  Emergency Management  declarations / accountability /
 *                                  reunification / procedures
 *   SAF-003  Incident Reporting    non-discipline incident logging
 *   SAF-004  Drill Management      schedule / complete drills
 *
 * The plan text used SAF-002 + SAF-003 but SAF-002 is the Visitor
 * Management code (P2C1). Using it here would conflate emergency
 * authority with visitor-portal scope. The catalogue is the
 * authoritative source - SAF-001 is the canonical Emergency
 * Management code.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  controllers: [IncidentsController],
  providers: [
    IncidentService,
    IncidentTypeService,
    ProcedureService,
    TimelineService,
    AccountabilityService,
    ReunificationService,
    DrillService,
    NonDisciplineIncidentService,
    DeclarationOutboxWorker,
  ],
  exports: [IncidentService, IncidentTypeService, ProcedureService, AccountabilityService],
})
export class IncidentsModule {}
