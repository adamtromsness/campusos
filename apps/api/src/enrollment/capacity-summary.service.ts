import { Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';

/**
 * Maintains `enr_capacity_summary` rows. Called from inside an open
 * tenant transaction by ApplicationService and OfferService whenever an
 * application or offer status changes that would shift the per-(period,
 * grade) counters.
 *
 * The materialised view philosophy here matches Cycle 6 Step 1's plan —
 * no DB triggers, the application service owns the formula. The single
 * `recompute` entrypoint runs one tenant-scoped query that aggregates
 * applications + offers + waitlist rows for the (period, grade) tuple
 * and UPSERTs the summary row in place. Always idempotent.
 */
@Injectable()
export class CapacitySummaryService {
  /**
   * Recompute the summary row for a (period, grade) tuple. Caller MUST
   * be inside an open tenant transaction (`executeInTenantTransaction`)
   * and pass the tx client. We do not start our own transaction so the
   * recompute is atomic with the status flip that caused it.
   *
   * REVIEW-CYCLE6 fix 9: take a per-(period, grade) advisory tx lock at
   * the top of the recompute. Without it, two concurrent transitions
   * touching the same (period, grade) — e.g. one ACCEPT and one
   * WITHDRAW — could both read source counters before either's status
   * write was visible, leading to a last-writer-wins UPSERT that
   * undercounts. The lock pins the recompute to a single executor at a
   * time per (period, grade) key; the schema's UNIQUE(period_id,
   * grade_level) on enr_capacity_summary is the belt-and-braces.
   */
  async recompute(tx: any, enrollmentPeriodId: string, gradeLevel: string): Promise<void> {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtext('enr_capacity_summary:' || $1::text || ':' || $2::text))",
      enrollmentPeriodId,
      gradeLevel,
    );
    var totals = (await tx.$queryRawUnsafe(
      'SELECT COALESCE(SUM(total_places), 0)::int AS total_places, COALESCE(SUM(reserved_places), 0)::int AS reserved ' +
        'FROM enr_intake_capacities WHERE enrollment_period_id = $1::uuid AND grade_level = $2',
      enrollmentPeriodId,
      gradeLevel,
    )) as Array<{ total_places: number; reserved: number }>;
    var totalPlaces = totals[0]?.total_places ?? 0;
    var reserved = totals[0]?.reserved ?? 0;

    var appCounts = (await tx.$queryRawUnsafe(
      "SELECT COUNT(*) FILTER (WHERE status NOT IN ('DRAFT'))::int AS received, " +
        "COUNT(*) FILTER (WHERE status = 'WAITLISTED')::int AS waitlisted " +
        'FROM enr_applications WHERE enrollment_period_id = $1::uuid AND applying_for_grade = $2',
      enrollmentPeriodId,
      gradeLevel,
    )) as Array<{ received: number; waitlisted: number }>;
    var received = appCounts[0]?.received ?? 0;
    var waitlisted = appCounts[0]?.waitlisted ?? 0;

    var offerCounts = (await tx.$queryRawUnsafe(
      "SELECT COUNT(*) FILTER (WHERE o.status IN ('ISSUED','ACCEPTED'))::int AS issued, " +
        "COUNT(*) FILTER (WHERE o.status = 'ACCEPTED')::int AS accepted " +
        'FROM enr_offers o JOIN enr_applications a ON a.id = o.application_id ' +
        'WHERE a.enrollment_period_id = $1::uuid AND a.applying_for_grade = $2',
      enrollmentPeriodId,
      gradeLevel,
    )) as Array<{ issued: number; accepted: number }>;
    var offersIssued = offerCounts[0]?.issued ?? 0;
    var offersAccepted = offerCounts[0]?.accepted ?? 0;

    var available = Math.max(0, totalPlaces - reserved - offersAccepted);

    var existing = (await tx.$queryRawUnsafe(
      'SELECT id FROM enr_capacity_summary WHERE enrollment_period_id = $1::uuid AND grade_level = $2',
      enrollmentPeriodId,
      gradeLevel,
    )) as Array<{ id: string }>;
    if (existing.length > 0) {
      await tx.$executeRawUnsafe(
        'UPDATE enr_capacity_summary SET total_places=$1::int, reserved=$2::int, applications_received=$3::int, offers_issued=$4::int, offers_accepted=$5::int, waitlisted=$6::int, available=$7::int, updated_at=now() ' +
          'WHERE id=$8::uuid',
        totalPlaces,
        reserved,
        received,
        offersIssued,
        offersAccepted,
        waitlisted,
        available,
        existing[0]!.id,
      );
    } else {
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_capacity_summary (id, enrollment_period_id, grade_level, total_places, reserved, applications_received, offers_issued, offers_accepted, waitlisted, available) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::int, $5::int, $6::int, $7::int, $8::int, $9::int, $10::int)',
        generateId(),
        enrollmentPeriodId,
        gradeLevel,
        totalPlaces,
        reserved,
        received,
        offersIssued,
        offersAccepted,
        waitlisted,
        available,
      );
    }
  }
}
