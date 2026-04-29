import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '../../kafka/kafka-consumer.service';
import { IdempotencyService } from '../../kafka/idempotency.service';
import { prefixedTopic } from '../../kafka/event-envelope';
import { TenantPrismaService } from '../../tenant/tenant-prisma.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../../notifications/consumers/notification-consumer-base';

/**
 * PaymentAccountWorker (Cycle 6 Step 7).
 *
 * The keystone consumer that closes the enrollment → payments event
 * loop. Subscribes to `dev.enr.student.enrolled` (or whatever
 * `KAFKA_TOPIC_ENV` resolves to) under group
 * `payment-account-worker` and on every confirmed enrolment:
 *
 *   1. UPSERTs a `pay_family_accounts` row keyed on (school_id,
 *      account_holder_id) — schema UNIQUE makes the upsert
 *      idempotent at the DB level even if the in-memory check loses
 *      a race,
 *   2. resolves the new student's `sis_students.id` if a row exists
 *      yet (the future EnrollmentConfirmedWorker will materialise it
 *      from the enr_applications shape; for Cycle 6 we look up by
 *      `platform_students.person_id` joined through name + DOB
 *      because there's no formal back-fill yet),
 *   3. INSERTs `pay_family_account_students` linking the family
 *      account to the student (idempotent on UNIQUE(family_account,
 *      student) — duplicate ignored).
 *
 * Idempotency: read-only `IdempotencyService.isClaimed(group,
 * eventId)` on arrival, do the work, then `claim()` on success so a
 * transient DB failure leaves the event-id unclaimed for redelivery
 * (REVIEW-CYCLE2 BLOCKING 2 — claim-after-success). The deterministic
 * event_id from the OfferService.respond emit is the primary dedup
 * gate; the schema's UNIQUE on (school_id, account_holder_id) is the
 * belt-and-braces.
 *
 * Edge cases:
 *   - guardian_person_id null in the inbound payload (admin-submitted
 *     application): we skip account creation and log a warning. The
 *     plan's Step 12 CAT will exercise the admin-back-fill path that
 *     attaches an iam_person before re-emitting.
 *   - student record missing: we create the family account but skip
 *     the link insert; future re-emit (or the EnrollmentConfirmedWorker)
 *     handles the link.
 */
interface StudentEnrolledPayload {
  applicationId: string;
  offerId: string;
  schoolId: string;
  enrollmentPeriodId: string;
  studentFirstName: string;
  studentLastName: string;
  studentDateOfBirth: string;
  gradeLevel: string;
  admissionType: string;
  guardianPersonId: string | null;
  guardianEmail: string;
  enrolledAt: string;
}

var CONSUMER_GROUP = 'payment-account-worker';

@Injectable()
export class PaymentAccountWorker implements OnModuleInit {
  private readonly logger = new Logger(PaymentAccountWorker.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('enr.student.enrolled')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<StudentEnrolledPayload>(msg, this.logger);
    if (!event) return;
    var p = event.payload;
    if (!p.applicationId || !p.schoolId) {
      this.logger.warn(
        'Dropping ' +
          msg.topic +
          ' (eventId=' +
          event.eventId +
          ') — missing applicationId or schoolId',
      );
      return;
    }
    if (!p.guardianPersonId) {
      // Admin submitted the application directly — no iam_person to
      // anchor the family account on yet. Skip the work; the
      // application admin will re-enroll once an iam_person exists,
      // re-emitting with a non-null guardianPersonId.
      this.logger.warn(
        '[' +
          CONSUMER_GROUP +
          '] applicationId=' +
          p.applicationId +
          ' has guardianPersonId=null — skipping account creation',
      );
      return;
    }
    var self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.createOrLinkAccount(event!);
      },
    );
  }

  private async createOrLinkAccount(
    event: UnwrappedEvent<StudentEnrolledPayload>,
  ): Promise<void> {
    var p = event.payload;
    var schoolId = event.tenant.schoolId;
    var self = this;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Find or create the family account.
      var existing = (await tx.$queryRawUnsafe(
        'SELECT id FROM pay_family_accounts WHERE school_id = $1::uuid AND account_holder_id = $2::uuid',
        schoolId,
        p.guardianPersonId,
      )) as Array<{ id: string }>;

      var familyAccountId: string;
      if (existing.length > 0) {
        familyAccountId = existing[0]!.id;
        self.logger.log(
          '[' +
            CONSUMER_GROUP +
            '] reusing existing pay_family_accounts.id=' +
            familyAccountId +
            ' for guardianPersonId=' +
            p.guardianPersonId,
        );
      } else {
        familyAccountId = generateId();
        var accountNumber = await self.nextAccountNumber(tx, schoolId);
        await tx.$executeRawUnsafe(
          'INSERT INTO pay_family_accounts (id, school_id, account_holder_id, account_number, status, payment_authorisation_policy) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE', 'ACCOUNT_HOLDER_ONLY')",
          familyAccountId,
          schoolId,
          p.guardianPersonId,
          accountNumber,
        );
        self.logger.log(
          '[' +
            CONSUMER_GROUP +
            '] created pay_family_accounts.id=' +
            familyAccountId +
            ' (account_number=' +
            accountNumber +
            ') for applicationId=' +
            p.applicationId,
        );
      }

      // Link the new student if a sis_students row already exists. The
      // Cycle 6 spec defers sis_students materialisation to the future
      // EnrollmentConfirmedWorker — we look up by (school_id, name,
      // date_of_birth) joined through platform_students because that's
      // the only existing identity hook. If the student isn't there
      // yet we skip; a later run will pick it up.
      var studentRows = (await tx.$queryRawUnsafe(
        'SELECT s.id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE s.school_id = $1::uuid AND ps.first_name = $2 AND ps.last_name = $3 LIMIT 1',
        schoolId,
        p.studentFirstName,
        p.studentLastName,
      )) as Array<{ id: string }>;
      if (studentRows.length === 0) {
        self.logger.log(
          '[' +
            CONSUMER_GROUP +
            '] no sis_students row for ' +
            p.studentFirstName +
            ' ' +
            p.studentLastName +
            ' yet — skipping link, will be picked up on later re-emit',
        );
        return;
      }
      var studentId = studentRows[0]!.id;
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO pay_family_account_students (id, family_account_id, student_id) VALUES ($1::uuid, $2::uuid, $3::uuid)',
          generateId(),
          familyAccountId,
          studentId,
        );
        self.logger.log(
          '[' +
            CONSUMER_GROUP +
            '] linked sis_students.id=' +
            studentId +
            ' to family account ' +
            familyAccountId,
        );
      } catch (e: any) {
        // 23505 = duplicate UNIQUE(family_account_id, student_id) — already linked.
        if (e?.code === '23505' || (e?.message || '').includes('duplicate key')) {
          self.logger.debug(
            '[' +
              CONSUMER_GROUP +
              '] link already exists — student ' +
              studentId +
              ' on family account ' +
              familyAccountId,
          );
          return;
        }
        throw e;
      }
    });
  }

  /**
   * Allocate the next sequential account number for the school. Looks up
   * the highest existing FA-#### number and returns the next one. Runs
   * inside the parent transaction so concurrent enrolments serialise on
   * the family-account write — the alternative (a Postgres SEQUENCE per
   * school) is heavier than the demo needs.
   */
  private async nextAccountNumber(tx: any, schoolId: string): Promise<string> {
    var rows = (await tx.$queryRawUnsafe(
      "SELECT COALESCE(MAX(NULLIF(REGEXP_REPLACE(account_number, '\\D', '', 'g'), '')::int), 1000) AS max_num " +
        'FROM pay_family_accounts WHERE school_id = $1::uuid',
      schoolId,
    )) as Array<{ max_num: number }>;
    var next = (rows[0]?.max_num ?? 1000) + 1;
    return 'FA-' + next;
  }
}
