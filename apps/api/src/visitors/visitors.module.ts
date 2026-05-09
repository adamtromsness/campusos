import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { BannedPersonService } from './banned-person.service';
import { MusterService } from './muster.service';
import { PreRegistrationService, RecurringVisitorService, SignInService } from './sign-in.service';
import { SignInSettingsService, VisitorService, VisitorTypeService } from './visitor.service';
import { VisitorsController } from './visitors.controller';

/**
 * Visitor Management Module — M90 (Phase 2 Cycle 1).
 *
 * 6 services + 1 controller + ~28 endpoints + 3 Kafka emit topics
 * (vis.visitor.signed_in, vis.banned_person.detected, vis.muster.created).
 *
 * Two structural keystones:
 *   1. Encrypted PII at rest (AES-256-GCM via Node crypto) with
 *      HMAC-SHA256 blind index for kiosk returning-visitor lookup.
 *      The kiosk lookup endpoint never decrypts — it computes the
 *      HMAC of the entered email and matches against email_hash.
 *      Cycle 22 IT vault wire format (base64(iv).base64(tag).
 *      base64(ciphertext)) is reused here.
 *   2. Banned-persons screening on every sign-in via HMAC name_hash
 *      blind index. A match BLOCKS the sign-in, displays a neutral
 *      message ("please see reception staff"), and emits
 *      vis.banned_person.detected so the safeguarding officer is
 *      paged. Per ADR-015 third-party DBS / background-check
 *      registry data is never persisted — only the reference id and
 *      the pass/fail status.
 *
 * Authorisation contract:
 *   - SAF-002:read   — Teacher (on-site list + today's pre-regs),
 *                      Staff (full reception surface), Admin
 *                      (everything via everyFunction).
 *   - SAF-002:write  — Staff (process sign-ins, manage pre-regs,
 *                      bypass safeguarding) + Admin.
 *   - SAF-002:admin  — School Admin + Platform Admin via
 *                      everyFunction. Visitor type catalogue +
 *                      sign-in settings + bypass authority.
 *   - safeguarding_ban:read — School Admin + Platform Admin only.
 *                      Banned persons plaintext name + court order
 *                      S3 key. Reception staff never reach this
 *                      surface.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    VisitorTypeService,
    VisitorService,
    SignInSettingsService,
    SignInService,
    PreRegistrationService,
    RecurringVisitorService,
    BannedPersonService,
    MusterService,
  ],
  controllers: [VisitorsController],
  exports: [
    VisitorTypeService,
    VisitorService,
    SignInService,
    PreRegistrationService,
    RecurringVisitorService,
    BannedPersonService,
    MusterService,
  ],
})
export class VisitorsModule {}
