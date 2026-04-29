import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { CapacitySummaryService } from './capacity-summary.service';
import {
  CreateOfferDto,
  OfferResponseDto,
  RespondToOfferDto,
  UpdateOfferConditionsMetDto,
} from './dto/offer.dto';

interface OfferRow {
  id: string;
  school_id: string;
  application_id: string;
  student_first_name: string;
  student_last_name: string;
  applying_for_grade: string;
  offer_type: string;
  offer_conditions: string[] | null;
  conditions_met: boolean | null;
  offer_letter_s3_key: string | null;
  issued_at: string;
  response_deadline: string;
  family_response: string | null;
  family_responded_at: string | null;
  deferral_target_year_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  enrollment_period_id: string;
  guardian_person_id: string | null;
  guardian_email: string;
  admission_type: string;
}

function offerRowToDto(r: OfferRow): OfferResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    applicationId: r.application_id,
    studentFirstName: r.student_first_name,
    studentLastName: r.student_last_name,
    applyingForGrade: r.applying_for_grade,
    offerType: r.offer_type as OfferResponseDto['offerType'],
    offerConditions: r.offer_conditions,
    conditionsMet: r.conditions_met,
    offerLetterS3Key: r.offer_letter_s3_key,
    issuedAt: r.issued_at,
    responseDeadline: r.response_deadline,
    familyResponse: r.family_response as OfferResponseDto['familyResponse'],
    familyRespondedAt: r.family_responded_at,
    deferralTargetYearId: r.deferral_target_year_id,
    status: r.status as OfferResponseDto['status'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

var SELECT_OFFER_BASE =
  'SELECT o.id, o.school_id, o.application_id, ' +
  'a.student_first_name, a.student_last_name, a.applying_for_grade, ' +
  'a.enrollment_period_id, a.guardian_person_id, a.guardian_email, a.admission_type, ' +
  'o.offer_type, o.offer_conditions, o.conditions_met, o.offer_letter_s3_key, ' +
  'o.issued_at, o.response_deadline, o.family_response, o.family_responded_at, ' +
  'o.deferral_target_year_id, o.status, o.created_at, o.updated_at ' +
  'FROM enr_offers o ' +
  'JOIN enr_applications a ON a.id = o.application_id ';

@Injectable()
export class OfferService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly capacity: CapacitySummaryService,
  ) {}

  async list(actor: ResolvedActor): Promise<OfferResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_OFFER_BASE + 'WHERE 1=1 ';
      var params: any[] = [];
      var idx = 1;
      if (!actor.isSchoolAdmin) {
        if (actor.personType !== 'GUARDIAN') return [] as OfferRow[];
        sql += 'AND a.guardian_person_id = $' + idx + '::uuid ';
        params.push(actor.personId);
        idx++;
      }
      sql += 'ORDER BY o.issued_at DESC';
      return client.$queryRawUnsafe<OfferRow[]>(sql, ...params);
    });
    return rows.map(offerRowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<OfferResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<OfferRow[]>(
        SELECT_OFFER_BASE + 'WHERE o.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Offer ' + id + ' not found');
    var row = rows[0]!;
    if (!actor.isSchoolAdmin) {
      if (actor.personType !== 'GUARDIAN' || row.guardian_person_id !== actor.personId) {
        throw new NotFoundException('Offer ' + id + ' not found');
      }
    }
    return offerRowToDto(row);
  }

  /**
   * Issue an offer on an application. Admin-only. Application must be in
   * ACCEPTED or WAITLISTED status; the schema enforces UNIQUE on
   * application_id so a re-issue fails loudly with 23505 (caller never
   * sees that — the pre-check converts to a 400 first).
   */
  async issue(
    applicationId: string,
    body: CreateOfferDto,
    actor: ResolvedActor,
  ): Promise<OfferResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can issue offers');
    }
    var schoolId = getCurrentTenant().schoolId;
    var offerType = body.offerType ?? 'UNCONDITIONAL';
    if (offerType === 'CONDITIONAL') {
      if (!body.offerConditions || body.offerConditions.length === 0) {
        throw new BadRequestException(
          'CONDITIONAL offers require at least one entry in offerConditions',
        );
      }
    } else {
      if (body.offerConditions && body.offerConditions.length > 0) {
        throw new BadRequestException(
          'UNCONDITIONAL offers cannot carry offerConditions — use CONDITIONAL',
        );
      }
    }
    var offerId = generateId();
    var nowIso = new Date().toISOString();
    if (new Date(body.responseDeadline) <= new Date(nowIso)) {
      throw new BadRequestException('responseDeadline must be after now');
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id, status, applying_for_grade, enrollment_period_id FROM enr_applications WHERE id = $1::uuid FOR UPDATE',
        applicationId,
      )) as Array<{
        id: string;
        status: string;
        applying_for_grade: string;
        enrollment_period_id: string;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Application ' + applicationId + ' not found');
      }
      var app = rows[0]!;
      if (app.status !== 'ACCEPTED' && app.status !== 'WAITLISTED') {
        throw new BadRequestException(
          'Cannot issue an offer on application in status ' +
            app.status +
            '; expected ACCEPTED or WAITLISTED',
        );
      }
      var existing = (await tx.$queryRawUnsafe(
        'SELECT id FROM enr_offers WHERE application_id = $1::uuid',
        applicationId,
      )) as Array<{ id: string }>;
      if (existing.length > 0) {
        throw new BadRequestException('Application already has an offer issued');
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_offers (id, school_id, application_id, offer_type, offer_conditions, offer_letter_s3_key, issued_at, response_deadline, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::text[], $6, $7::timestamptz, $8::timestamptz, 'ISSUED')",
        offerId,
        schoolId,
        applicationId,
        offerType,
        offerType === 'CONDITIONAL' ? body.offerConditions! : null,
        body.offerLetterS3Key ?? null,
        nowIso,
        body.responseDeadline,
      );
      await this.capacity.recompute(tx, app.enrollment_period_id, app.applying_for_grade);
    });

    var dto = await this.getById(offerId, actor);
    void this.kafka.emit({
      topic: 'enr.offer.issued',
      key: offerId,
      sourceModule: 'enrollment',
      payload: {
        offerId: offerId,
        applicationId: applicationId,
        offerType: offerType,
        responseDeadline: body.responseDeadline,
        guardianPersonId: dto.familyResponse,
        studentFirstName: dto.studentFirstName,
        studentLastName: dto.studentLastName,
        applyingForGrade: dto.applyingForGrade,
      },
    });
    return dto;
  }

  /**
   * Admin marks the conditions on a CONDITIONAL offer as met or not met.
   * conditions_met=true unlocks the parent ACCEPT path; false transitions
   * the offer to CONDITIONS_NOT_MET (terminal failure state).
   */
  async setConditionsMet(
    id: string,
    body: UpdateOfferConditionsMetDto,
    actor: ResolvedActor,
  ): Promise<OfferResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update offer conditions');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id, offer_type, status FROM enr_offers WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; offer_type: string; status: string }>;
      if (rows.length === 0) {
        throw new NotFoundException('Offer ' + id + ' not found');
      }
      var offer = rows[0]!;
      if (offer.offer_type !== 'CONDITIONAL') {
        throw new BadRequestException('Only CONDITIONAL offers can have conditions verified');
      }
      if (offer.status !== 'ISSUED') {
        throw new BadRequestException(
          'Cannot verify conditions on an offer in status ' + offer.status,
        );
      }
      if (body.conditionsMet === false) {
        await tx.$executeRawUnsafe(
          "UPDATE enr_offers SET conditions_met = false, status = 'CONDITIONS_NOT_MET', updated_at = now() WHERE id = $1::uuid",
          id,
        );
      } else {
        await tx.$executeRawUnsafe(
          'UPDATE enr_offers SET conditions_met = true, updated_at = now() WHERE id = $1::uuid',
          id,
        );
      }
    });
    return this.getById(id, actor);
  }

  /**
   * Parent (or admin acting for the parent) responds to an offer. The
   * critical state-machine path — locks the row with FOR UPDATE inside
   * the tx that flips status (Cycle 5 review carry-over: state-machine
   * transitions must lock the row).
   *
   * On ACCEPT:
   *   - Offer status flips ISSUED→ACCEPTED, family_response=ACCEPTED,
   *     family_responded_at populated under response_pair_chk.
   *   - Application status flips to ENROLLED.
   *   - enr.student.enrolled emits with the full student + guardian
   *     payload — the future PaymentAccountWorker (Step 7) consumes
   *     this to create pay_family_accounts + pay_family_account_students.
   *
   * On DECLINE: offer status DECLINED, no application side-effects.
   *
   * On DEFER: offer status retains ISSUED but family_response=DEFERRED
   *   with deferral_target_year_id required (deferred_chk on the schema).
   *   No application side-effects in Cycle 6 — admin will re-evaluate
   *   the deferred offer next cycle.
   */
  async respond(
    id: string,
    body: RespondToOfferDto,
    actor: ResolvedActor,
  ): Promise<OfferResponseDto> {
    var preflight = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<Array<{ guardian_person_id: string | null }>>(
        'SELECT a.guardian_person_id FROM enr_offers o JOIN enr_applications a ON a.id = o.application_id WHERE o.id = $1::uuid',
        id,
      );
      return rows[0] ?? null;
    });
    if (!preflight) {
      throw new NotFoundException('Offer ' + id + ' not found');
    }
    if (!actor.isSchoolAdmin) {
      if (
        actor.personType !== 'GUARDIAN' ||
        preflight.guardian_person_id !== actor.personId
      ) {
        throw new ForbiddenException('Only the owning guardian can respond to this offer');
      }
    }
    if (body.familyResponse === 'DEFERRED' && !body.deferralTargetYearId) {
      throw new BadRequestException('DEFERRED responses require deferralTargetYearId');
    }

    var transitionResult = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT o.id, o.application_id, o.offer_type, o.conditions_met, o.status, ' +
          'a.applying_for_grade, a.enrollment_period_id, a.guardian_person_id, a.guardian_email, ' +
          'a.student_first_name, a.student_last_name, a.student_date_of_birth, a.admission_type ' +
          'FROM enr_offers o JOIN enr_applications a ON a.id = o.application_id ' +
          'WHERE o.id = $1::uuid FOR UPDATE OF o, a',
        id,
      )) as Array<{
        id: string;
        application_id: string;
        offer_type: string;
        conditions_met: boolean | null;
        status: string;
        applying_for_grade: string;
        enrollment_period_id: string;
        guardian_person_id: string | null;
        guardian_email: string;
        student_first_name: string;
        student_last_name: string;
        student_date_of_birth: string;
        admission_type: string;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Offer ' + id + ' not found');
      }
      var offer = rows[0]!;
      if (offer.status !== 'ISSUED') {
        throw new BadRequestException(
          'Offer is in status ' + offer.status + ' — only ISSUED offers can be responded to',
        );
      }
      if (
        body.familyResponse === 'ACCEPTED' &&
        offer.offer_type === 'CONDITIONAL' &&
        offer.conditions_met !== true
      ) {
        throw new BadRequestException(
          'CONDITIONAL offer cannot be accepted until conditions_met is verified',
        );
      }

      var nowIso = new Date().toISOString();
      if (body.familyResponse === 'ACCEPTED') {
        await tx.$executeRawUnsafe(
          "UPDATE enr_offers SET family_response = 'ACCEPTED', family_responded_at = $1::timestamptz, status = 'ACCEPTED', updated_at = now() WHERE id = $2::uuid",
          nowIso,
          id,
        );
        await tx.$executeRawUnsafe(
          "UPDATE enr_applications SET status = 'ENROLLED', updated_at = now() WHERE id = $1::uuid",
          offer.application_id,
        );
        await this.capacity.recompute(
          tx,
          offer.enrollment_period_id,
          offer.applying_for_grade,
        );
      } else if (body.familyResponse === 'DECLINED') {
        await tx.$executeRawUnsafe(
          "UPDATE enr_offers SET family_response = 'DECLINED', family_responded_at = $1::timestamptz, status = 'DECLINED', updated_at = now() WHERE id = $2::uuid",
          nowIso,
          id,
        );
        await this.capacity.recompute(
          tx,
          offer.enrollment_period_id,
          offer.applying_for_grade,
        );
      } else {
        // DEFERRED: family_response set, status stays ISSUED so the schema
        // partial INDEX on response_deadline keeps tracking the deadline.
        await tx.$executeRawUnsafe(
          "UPDATE enr_offers SET family_response = 'DEFERRED', family_responded_at = $1::timestamptz, deferral_target_year_id = $2::uuid, updated_at = now() WHERE id = $3::uuid",
          nowIso,
          body.deferralTargetYearId!,
          id,
        );
      }
      return offer;
    });

    var dto = await this.getById(id, actor);
    if (body.familyResponse === 'ACCEPTED') {
      void this.kafka.emit({
        topic: 'enr.student.enrolled',
        key: transitionResult.application_id,
        sourceModule: 'enrollment',
        payload: {
          applicationId: transitionResult.application_id,
          offerId: id,
          schoolId: dto.schoolId,
          enrollmentPeriodId: transitionResult.enrollment_period_id,
          studentFirstName: transitionResult.student_first_name,
          studentLastName: transitionResult.student_last_name,
          studentDateOfBirth: transitionResult.student_date_of_birth,
          gradeLevel: transitionResult.applying_for_grade,
          admissionType: transitionResult.admission_type,
          guardianPersonId: transitionResult.guardian_person_id,
          guardianEmail: transitionResult.guardian_email,
          enrolledAt: dto.familyRespondedAt,
        },
      });
    }
    void this.kafka.emit({
      topic: 'enr.offer.responded',
      key: id,
      sourceModule: 'enrollment',
      payload: {
        offerId: id,
        applicationId: transitionResult.application_id,
        familyResponse: body.familyResponse,
        respondedAt: dto.familyRespondedAt,
      },
    });
    return dto;
  }
}
