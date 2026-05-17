import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { OutboxService } from '@shared/kafka';
import { generateId } from '@campusos/database';
import { AssignmentResponseDto, JobPostingResponseDto, PostJobDto } from './dto/substitutes.dto';

interface JobRow {
  id: string;
  school_id: string;
  absent_teacher_id: string;
  absent_teacher_name: string | null;
  job_date: string;
  start_time: string;
  end_time: string;
  job_type: string;
  grade_level: string | null;
  subject: string | null;
  status: string;
  notification_tier: string;
  acceptance_window_minutes: number;
  escalate_to_marketplace_at: string | null;
  filled_at: string | null;
  created_at: string;
}

const SELECT_JOB_BASE = `
  SELECT j.id::text AS id,
         j.school_id::text AS school_id,
         j.absent_teacher_id::text AS absent_teacher_id,
         (ip.first_name || ' ' || ip.last_name) AS absent_teacher_name,
         j.job_date::text AS job_date,
         j.start_time::text AS start_time,
         j.end_time::text AS end_time,
         j.job_type, j.grade_level, j.subject,
         j.status, j.notification_tier, j.acceptance_window_minutes,
         TO_CHAR(j.escalate_to_marketplace_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS escalate_to_marketplace_at,
         TO_CHAR(j.filled_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS filled_at,
         TO_CHAR(j.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_at
  FROM sub_job_postings j
  LEFT JOIN hr_employees e
    ON e.id = j.absent_teacher_id
   AND e.school_id = j.school_id
  LEFT JOIN platform.iam_person ip ON ip.id = e.person_id
`;

/**
 * JobPostingService — P2-9 Step 6.
 *
 * Owns the substitute job posting lifecycle (sub_job_postings + sub_job_classes
 * + sub_job_notifications + sub_assignments). The keystone is post() —
 * the admin posts a job, the service computes the acceptance window,
 * resolves the school pool to fan out tier-1 notifications, and emits
 * sub.job.posted via the outbox so Kafka delivery is durable.
 */
@Injectable()
export class JobPostingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'sub-002:write',
    ]);
  }

  // ── Reads ────────────────────────────────────────────────────────

  async list(actor: ResolvedActor, status?: string): Promise<JobPostingResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_JOB_BASE + ' WHERE j.school_id = $1::uuid';
      const params: unknown[] = [tenant.schoolId];

      // Substitute persona: filter to jobs they were notified about. Marketplace
      // admins see all jobs.
      if (!(await this.hasAdminScope(actor))) {
        if (!actor.personId) return [];
        const platform = this.tenantPrisma.getPlatformClient();
        const profile = await platform.substituteProfile.findUnique({
          where: { personId: actor.personId },
        });
        if (!profile) return [];
        sql += ` AND EXISTS (
          SELECT 1 FROM sub_job_notifications n
          WHERE n.job_id = j.id AND n.substitute_id = $${params.length + 1}::uuid
        )`;
        params.push(profile.id);
      }

      if (status) {
        sql += ` AND j.status = $${params.length + 1}`;
        params.push(status);
      }
      sql += ' ORDER BY j.job_date DESC, j.created_at DESC';
      const rows = (await client.$queryRawUnsafe(sql, ...params)) as JobRow[];
      return Promise.all(rows.map((r) => this.hydrateJob(client, r)));
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<JobPostingResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_JOB_BASE + ' WHERE j.id = $1::uuid AND j.school_id = $2::uuid',
        id,
        tenant.schoolId,
      )) as JobRow[];
      if (rows.length === 0) throw new NotFoundException('Job posting not found');

      // Visibility: admin sees all; substitute sees only if notified.
      if (!(await this.hasAdminScope(actor))) {
        if (!actor.personId) throw new NotFoundException('Job posting not found');
        const platform = this.tenantPrisma.getPlatformClient();
        const profile = await platform.substituteProfile.findUnique({
          where: { personId: actor.personId },
        });
        if (!profile) throw new NotFoundException('Job posting not found');
        const seen = (await client.$queryRawUnsafe(
          'SELECT 1 FROM sub_job_notifications WHERE job_id = $1::uuid AND substitute_id = $2::uuid LIMIT 1',
          id,
          profile.id,
        )) as Array<unknown>;
        if (seen.length === 0) throw new NotFoundException('Job posting not found');
      }
      return this.hydrateJob(client, rows[0]!);
    });
  }

  // ── Post a job — the keystone ────────────────────────────────────

  async post(input: PostJobDto, actor: ResolvedActor): Promise<JobPostingResponseDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Only school admins can post substitute jobs.');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    const acceptanceMins = input.acceptanceWindowMinutes ?? 30;
    const escalateAt = new Date(Date.now() + acceptanceMins * 60 * 1000);

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C9 BLOCKING 2: validate the absent teacher belongs to
      // THIS school. The previous id-only check let a multi-school
      // tenant pool post a sub job using a foreign-school teacher UUID,
      // which would then poison fan-out + downstream coverage linkage.
      const teacher = (await tx.$queryRawUnsafe(
        'SELECT id FROM hr_employees WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        input.absentTeacherId,
      )) as Array<{ id: string }>;
      if (teacher.length === 0) {
        throw new BadRequestException('absentTeacherId does not match a teacher in this school.');
      }

      // INSERT the posting
      await tx.$executeRawUnsafe(
        `INSERT INTO sub_job_postings (
          id, school_id, absent_teacher_id, job_date, start_time, end_time,
          job_type, grade_level, subject, special_requirements,
          posted_by, status, acceptance_window_minutes, notification_tier, escalate_to_marketplace_at
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::time, $6::time,
          $7, $8, $9, $10, $11::uuid, 'OPEN', $12, 'POOL', $13::timestamptz)`,
        id,
        tenant.schoolId,
        input.absentTeacherId,
        input.jobDate,
        input.startTime,
        input.endTime,
        input.jobType ?? 'FULL_DAY',
        input.gradeLevel ?? null,
        input.subject ?? null,
        input.specialRequirements ?? null,
        actor.employeeId,
        acceptanceMins,
        escalateAt.toISOString(),
      );

      // Snapshot any timetable slots
      if (input.timetableSlotIds && input.timetableSlotIds.length > 0) {
        for (const slotId of input.timetableSlotIds) {
          // REVIEW-P2C9 BLOCKING 2: school-scope the slot lookup so a
          // foreign-school slot UUID cannot be snapshotted onto a
          // current-school job. sch_timetable_slots carries school_id
          // directly per Cycle 5 migration 016, so we predicate on it.
          const slot = (await tx.$queryRawUnsafe(
            `SELECT s.id, c.section_code, r.name AS room_name, p.name AS period_name
             FROM sch_timetable_slots s
             LEFT JOIN sis_classes c ON c.id = s.class_id
             LEFT JOIN sch_rooms r ON r.id = s.room_id
             LEFT JOIN sch_periods p ON p.id = s.period_id
             WHERE s.school_id = $1::uuid AND s.id = $2::uuid LIMIT 1`,
            tenant.schoolId,
            slotId,
          )) as Array<{
            id: string;
            section_code: string | null;
            room_name: string | null;
            period_name: string | null;
          }>;
          if (slot.length === 0) {
            throw new BadRequestException(`timetable_slot_id ${slotId} not found in this school.`);
          }
          const s = slot[0]!;
          await tx.$executeRawUnsafe(
            `INSERT INTO sub_job_classes (id, job_id, timetable_slot_id, class_name, room_name, period_label)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
            generateId(),
            id,
            slotId,
            s.section_code ?? 'Class',
            s.room_name,
            s.period_name,
          );
        }
      }

      // Tier 1: fan out notifications to ACTIVE pool members
      const poolMembers = (await tx.$queryRawUnsafe(
        `SELECT substitute_id::text AS substitute_id FROM sub_school_pool
         WHERE school_id = $1::uuid AND status = 'ACTIVE'`,
        tenant.schoolId,
      )) as Array<{ substitute_id: string }>;

      const notifiedAt = new Date();
      const expiresAt = new Date(notifiedAt.getTime() + acceptanceMins * 60 * 1000);
      for (const m of poolMembers) {
        // Honour BLOCKED preferences against this school
        const blocked = (await tx.$queryRawUnsafe(
          `SELECT 1 FROM platform.platform_sub_preferences
           WHERE substitute_id = $1::uuid AND school_id = $2::uuid AND preference_type = 'BLOCKED' LIMIT 1`,
          m.substitute_id,
          tenant.schoolId,
        )) as Array<unknown>;
        if (blocked.length > 0) continue;

        await tx.$executeRawUnsafe(
          `INSERT INTO sub_job_notifications (id, job_id, substitute_id, notification_tier, notified_at, acceptance_window_expires_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'POOL', $4::timestamptz, $5::timestamptz)
           ON CONFLICT (job_id, substitute_id) DO NOTHING`,
          generateId(),
          id,
          m.substitute_id,
          notifiedAt.toISOString(),
          expiresAt.toISOString(),
        );
      }

      // Emit sub.job.posted via outbox — durable.
      await this.outbox.enqueueInTx(tx as never, {
        topic: 'sub.job.posted',
        key: id,
        sourceModule: 'substitutes',
        payload: {
          jobId: id,
          schoolId: tenant.schoolId,
          absentTeacherId: input.absentTeacherId,
          jobDate: input.jobDate,
          startTime: input.startTime,
          endTime: input.endTime,
          jobType: input.jobType ?? 'FULL_DAY',
          gradeLevel: input.gradeLevel ?? null,
          subject: input.subject ?? null,
          notificationTier: 'POOL',
          poolSize: poolMembers.length,
          acceptanceWindowExpiresAt: expiresAt.toISOString(),
        },
      });

      const rows = (await tx.$queryRawUnsafe(
        SELECT_JOB_BASE + ' WHERE j.id = $1::uuid',
        id,
      )) as JobRow[];
      return this.hydrateJob(tx, rows[0]!);
    });
  }

  // ── Substitute responds ──────────────────────────────────────────

  async accept(jobId: string, actor: ResolvedActor): Promise<AssignmentResponseDto> {
    if (!actor.personId) {
      throw new ForbiddenException('Only authenticated substitutes can accept jobs.');
    }
    const tenant = getCurrentTenant();
    const platform = this.tenantPrisma.getPlatformClient();
    const profile = await platform.substituteProfile.findUnique({
      where: { personId: actor.personId },
    });
    if (!profile) throw new ForbiddenException('No substitute profile for this account.');

    const assignmentId = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the job row
      const job = (await tx.$queryRawUnsafe(
        `SELECT id, status FROM sub_job_postings
         WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        jobId,
        tenant.schoolId,
      )) as Array<{ id: string; status: string }>;
      if (job.length === 0) throw new NotFoundException('Job posting not found');
      if (job[0]!.status !== 'OPEN') {
        throw new ConflictException(
          `Job is no longer open (current status: ${job[0]!.status}). It may have been filled by another substitute.`,
        );
      }

      // Find this substitute's notification — must exist + be PENDING + not expired
      const notif = (await tx.$queryRawUnsafe(
        `SELECT id, response, acceptance_window_expires_at
         FROM sub_job_notifications
         WHERE job_id = $1::uuid AND substitute_id = $2::uuid
         FOR UPDATE`,
        jobId,
        profile.id,
      )) as Array<{ id: string; response: string; acceptance_window_expires_at: string }>;
      if (notif.length === 0) {
        throw new ForbiddenException('You were not notified for this job.');
      }
      if (notif[0]!.response !== 'PENDING') {
        throw new ConflictException(
          `Your notification is in status ${notif[0]!.response} and cannot be accepted.`,
        );
      }
      const expiresAt = new Date(notif[0]!.acceptance_window_expires_at);
      if (Date.now() > expiresAt.getTime()) {
        // Soft-flip to EXPIRED for the AcceptanceExpiryWorker contract.
        await tx.$executeRawUnsafe(
          `UPDATE sub_job_notifications SET response = 'EXPIRED', responded_at = now()
           WHERE id = $1::uuid`,
          notif[0]!.id,
        );
        throw new ConflictException('Acceptance window has expired for this notification.');
      }

      // Flip notification to ACCEPTED
      await tx.$executeRawUnsafe(
        `UPDATE sub_job_notifications SET response = 'ACCEPTED', responded_at = now()
         WHERE id = $1::uuid`,
        notif[0]!.id,
      );

      // Flip job to FILLED
      await tx.$executeRawUnsafe(
        `UPDATE sub_job_postings SET status = 'FILLED', filled_at = now()
         WHERE id = $1::uuid`,
        jobId,
      );

      // Create the assignment row
      await tx.$executeRawUnsafe(
        `INSERT INTO sub_assignments (id, job_id, substitute_id, confirmed_at, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'CONFIRMED')`,
        assignmentId,
        jobId,
        profile.id,
      );

      // Emit sub.assignment.confirmed via outbox
      await this.outbox.enqueueInTx(tx as never, {
        topic: 'sub.assignment.confirmed',
        key: assignmentId,
        sourceModule: 'substitutes',
        payload: {
          assignmentId,
          jobId,
          schoolId: tenant.schoolId,
          substituteId: profile.id,
          substituteName: profile.displayName,
          confirmedAt: new Date().toISOString(),
        },
      });

      return {
        id: assignmentId,
        jobId,
        substituteId: profile.id,
        confirmedAt: new Date().toISOString(),
        status: 'CONFIRMED',
        checkInAt: null,
        checkOutAt: null,
        isLateCancellation: false,
        cancelledAt: null,
        cancelledByType: null,
        cancellationReason: null,
      };
    });
  }

  async decline(
    jobId: string,
    actor: ResolvedActor,
  ): Promise<{ jobId: string; response: 'DECLINED' }> {
    if (!actor.personId) {
      throw new ForbiddenException('Only authenticated substitutes can decline jobs.');
    }
    const tenant = getCurrentTenant();
    const platform = this.tenantPrisma.getPlatformClient();
    const profile = await platform.substituteProfile.findUnique({
      where: { personId: actor.personId },
    });
    if (!profile) throw new ForbiddenException('No substitute profile for this account.');

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const notif = (await tx.$queryRawUnsafe(
        `SELECT id, response FROM sub_job_notifications n
         JOIN sub_job_postings j ON j.id = n.job_id AND j.school_id = $1::uuid
         WHERE n.job_id = $2::uuid AND n.substitute_id = $3::uuid FOR UPDATE OF n`,
        tenant.schoolId,
        jobId,
        profile.id,
      )) as Array<{ id: string; response: string }>;
      if (notif.length === 0) throw new NotFoundException('Notification not found');
      if (notif[0]!.response !== 'PENDING') {
        throw new ConflictException(`Notification is in status ${notif[0]!.response}.`);
      }
      await tx.$executeRawUnsafe(
        `UPDATE sub_job_notifications SET response = 'DECLINED', responded_at = now()
         WHERE id = $1::uuid`,
        notif[0]!.id,
      );
      return { jobId, response: 'DECLINED' as const };
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async hydrateJob(client: any, row: JobRow): Promise<JobPostingResponseDto> {
    const classes = (await client.$queryRawUnsafe(
      `SELECT id::text AS id, timetable_slot_id::text AS timetable_slot_id,
              class_name, room_name, period_label
       FROM sub_job_classes WHERE job_id = $1::uuid ORDER BY period_label NULLS LAST`,
      row.id,
    )) as Array<{
      id: string;
      timetable_slot_id: string;
      class_name: string;
      room_name: string | null;
      period_label: string | null;
    }>;

    const notifs = (await client.$queryRawUnsafe(
      `SELECT id::text AS id, substitute_id::text AS substitute_id, response,
              TO_CHAR(notified_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS notified_at,
              TO_CHAR(responded_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS responded_at,
              TO_CHAR(acceptance_window_expires_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS expires_at,
              notification_tier
       FROM sub_job_notifications WHERE job_id = $1::uuid ORDER BY notified_at`,
      row.id,
    )) as Array<{
      id: string;
      substitute_id: string;
      response: string;
      notified_at: string;
      responded_at: string | null;
      expires_at: string;
      notification_tier: string;
    }>;

    return {
      id: row.id,
      schoolId: row.school_id,
      absentTeacherId: row.absent_teacher_id,
      absentTeacherName: row.absent_teacher_name,
      jobDate: row.job_date,
      startTime: row.start_time,
      endTime: row.end_time,
      jobType: row.job_type as JobPostingResponseDto['jobType'],
      gradeLevel: row.grade_level,
      subject: row.subject,
      status: row.status as JobPostingResponseDto['status'],
      notificationTier: row.notification_tier as JobPostingResponseDto['notificationTier'],
      acceptanceWindowMinutes: row.acceptance_window_minutes,
      escalateToMarketplaceAt: row.escalate_to_marketplace_at,
      filledAt: row.filled_at,
      createdAt: row.created_at,
      classes: classes.map((c) => ({
        id: c.id,
        timetableSlotId: c.timetable_slot_id,
        className: c.class_name,
        roomName: c.room_name,
        periodLabel: c.period_label,
      })),
      notifications: notifs.map((n) => ({
        id: n.id,
        substituteId: n.substitute_id,
        response: n.response as JobPostingResponseDto['notifications'][number]['response'],
        notifiedAt: n.notified_at,
        respondedAt: n.responded_at,
        acceptanceWindowExpiresAt: n.expires_at,
        notificationTier: n.notification_tier as JobPostingResponseDto['notificationTier'],
      })),
    };
  }
}
