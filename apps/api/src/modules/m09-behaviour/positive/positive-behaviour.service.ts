import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { OutboxService } from '@shared/kafka';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  AwardPointsDto,
  BehaviourRewardResponseDto,
  BehaviourRewardType,
  BehaviourTransactionType,
  CreateRewardDto,
  PointsBalanceResponseDto,
  PointsTransactionResponseDto,
  RedeemRewardDto,
  RedemptionResponseDto,
  UpdateRewardDto,
} from './dto/behaviour-advanced.dto';
import { deterministicPositivePointsAwardedEventId } from './event-ids';

interface TransactionRow {
  id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  awarded_by: string | null;
  awarder_first: string | null;
  awarder_last: string | null;
  transaction_type: string;
  category: string | null;
  points: number;
  reason: string;
  reward_id: string | null;
  reward_name: string | null;
  awarded_at: string;
}

interface RewardRow {
  id: string;
  school_id: string;
  reward_name: string;
  description: string | null;
  points_cost: number;
  reward_type: string;
  quantity_available: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_TX_BASE =
  'SELECT pp.id::text AS id, pp.student_id::text AS student_id, ' +
  'sp.first_name AS student_first, sp.last_name AS student_last, ' +
  'pp.awarded_by::text AS awarded_by, ' +
  'ap.first_name AS awarder_first, ap.last_name AS awarder_last, ' +
  'pp.transaction_type, pp.category, pp.points, pp.reason, ' +
  'pp.reward_id::text AS reward_id, r.reward_name AS reward_name, ' +
  'TO_CHAR(pp.awarded_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS awarded_at ' +
  'FROM sis_positive_behaviour_points pp ' +
  'JOIN sis_students s ON s.id = pp.student_id ' +
  'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sp ON sp.id = ps.person_id ' +
  'LEFT JOIN hr_employees ae ON ae.id = pp.awarded_by ' +
  'LEFT JOIN platform.iam_person ap ON ap.id = ae.person_id ' +
  'LEFT JOIN sis_behaviour_rewards r ON r.id = pp.reward_id ';

const SELECT_REWARD_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, reward_name, description, ' +
  'points_cost, reward_type, quantity_available, is_active, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM sis_behaviour_rewards ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToTxDto(r: TransactionRow): PointsTransactionResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: fullName(r.student_first, r.student_last),
    awardedBy: r.awarded_by,
    awardedByName: fullName(r.awarder_first, r.awarder_last),
    transactionType: r.transaction_type as BehaviourTransactionType,
    category: r.category,
    points: r.points,
    reason: r.reason,
    rewardId: r.reward_id,
    rewardName: r.reward_name,
    awardedAt: r.awarded_at,
  };
}

function rowToRewardDto(r: RewardRow): BehaviourRewardResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    rewardName: r.reward_name,
    description: r.description,
    pointsCost: r.points_cost,
    rewardType: r.reward_type as BehaviourRewardType,
    quantityAvailable: r.quantity_available,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Positive Behaviour Service (P2-14 Step 4).
 *
 * Two surfaces:
 *  1. Points ledger — teacher awards plus student redemptions of
 *     marketplace rewards. transaction_type AWARD or REDEMPTION.
 *     Student balance = SUM(points where AWARD) - SUM(points where
 *     REDEMPTION). Emits beh.positive_points.awarded on every AWARD
 *     for the Cycle 3 NotificationConsumer parent fan-out.
 *  2. Rewards marketplace — admin-configured rewards catalogue with
 *     points_cost, reward_type, optional quantity_available.
 *     Redemption decrements quantity_available when set + validates
 *     student balance ≥ points_cost inside a locked tenant tx so
 *     two parallel redeem requests serialise on the parent reward
 *     row.
 */
@Injectable()
export class PositiveBehaviourService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async hasAwardScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'beh-001:write',
      'beh-001:admin',
    ]);
  }

  private async hasRewardAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'beh-001:admin',
    ]);
  }

  /**
   * REVIEW-P2C14 BLOCKING 3 — actor-aware row scope for the positive-points
   * balance/history read. Throws ForbiddenException if the caller is not
   * authorised to view this student's ledger.
   */
  private async assertCanReadBalance(studentId: string, actor: ResolvedActor): Promise<void> {
    const tenant = getCurrentTenant();
    // Admin / beh-001:admin holder — any student in school.
    if (actor.isSchoolAdmin) return;
    const hasAdmin = await this.permissions.hasAnyPermissionInTenant(
      actor.accountId,
      tenant.schoolId,
      ['beh-001:admin'],
    );
    if (hasAdmin) return;

    if (actor.personType === 'STUDENT') {
      // Student can only view own balance — resolve own sis_students.id
      // via platform_students.person_id chain and compare.
      const own = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const rows = (await client.$queryRawUnsafe(
          'SELECT s.id::text AS id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.school_id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
          tenant.schoolId,
          actor.personId,
        )) as Array<{ id: string }>;
        return rows[0]?.id ?? null;
      });
      if (!own || own !== studentId) {
        throw new ForbiddenException('Students can only view their own positive-points balance');
      }
      return;
    }

    if (actor.personType === 'GUARDIAN') {
      // Guardian can only view linked children — sis_student_guardians
      // joined to sis_guardians keyed on actor.personId.
      const linked = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const rows = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE g.person_id = $1::uuid AND sg.student_id = $2::uuid LIMIT 1',
          actor.personId,
          studentId,
        )) as Array<{ ok: number }>;
        return rows.length > 0;
      });
      if (!linked) {
        throw new ForbiddenException(
          'Guardians can only view positive-points balances for their own children',
        );
      }
      return;
    }

    if (actor.personType === 'STAFF' && actor.employeeId) {
      // Teacher / non-admin staff — only students enrolled in classes
      // they currently teach (sis_class_teachers + ACTIVE sis_enrollments).
      const allowed = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const rows = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_enrollments e ' +
            'JOIN sis_class_teachers ct ON ct.class_id = e.class_id ' +
            "WHERE e.status = 'ACTIVE' " +
            '  AND ct.teacher_employee_id = $1::uuid ' +
            '  AND e.student_id = $2::uuid LIMIT 1',
          actor.employeeId,
          studentId,
        )) as Array<{ ok: number }>;
        return rows.length > 0;
      });
      if (!allowed) {
        throw new ForbiddenException(
          'Teachers can only view positive-points balances for students in their classes',
        );
      }
      return;
    }

    throw new ForbiddenException(
      'This actor type cannot view positive-points balances for other students',
    );
  }

  /**
   * Award positive behaviour points to a student. Teacher/admin only.
   * category is a free-form string sourced from the school's
   * positive_behaviour_categories tenant config. Emits
   * beh.positive_points.awarded after the INSERT so the Cycle 3
   * NotificationConsumer can fan out an IN_APP notification to the
   * student's guardians.
   */
  async award(input: AwardPointsDto, actor: ResolvedActor): Promise<PointsTransactionResponseDto> {
    if (!(await this.hasAwardScope(actor))) {
      throw new ForbiddenException(
        'Only teachers or admins with beh-001:write can award positive behaviour points',
      );
    }
    const tenant = getCurrentTenant();
    const awarderId = actor.employeeId;
    if (!awarderId) {
      throw new BadRequestException('Caller has no hr_employees row in this school.');
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const stu = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM sis_students WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        input.studentId,
      )) as Array<{ id: string }>;
      if (stu.length === 0) {
        throw new BadRequestException('studentId does not match a student in this school');
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO sis_positive_behaviour_points ' +
          '(id, school_id, student_id, awarded_by, transaction_type, category, points, reason) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8)',
        id,
        tenant.schoolId,
        input.studentId,
        awarderId,
        'AWARD',
        input.category,
        input.points,
        input.reason,
      );
      // REVIEW-P2C14 MAJOR 5 — durable outbox emit inside the same tenant
      // tx as the AWARD INSERT. Previously best-effort kafka.emit() could
      // drop the event on broker outage even though the ledger row landed.
      // Outbox row commits with the tx; the OutboxPublisherWorker delivers
      // on broker recovery. Cycle 3 NotificationConsumer fans out the
      // parent IN_APP notification downstream of the outbox publication.
      await this.outbox.enqueueInTx(tx, {
        topic: 'beh.positive_points.awarded',
        key: id,
        payload: {
          transactionId: id,
          schoolId: tenant.schoolId,
          studentId: input.studentId,
          category: input.category,
          points: input.points,
          reason: input.reason,
          awardedAt: new Date().toISOString(),
          sourceRefId: id,
        },
        sourceModule: 'behaviour-advanced',
        eventId: deterministicPositivePointsAwardedEventId(id),
      });
    });

    return this.getTransactionById(id);
  }

  private async getTransactionById(id: string): Promise<PointsTransactionResponseDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_TX_BASE + 'WHERE pp.id = $1::uuid LIMIT 1',
        id,
      )) as TransactionRow[];
      const first = rows[0];
      if (!first) throw new NotFoundException('Points transaction not found');
      return rowToTxDto(first);
    });
  }

  /**
   * Compute student balance + history. Actor-aware row scope per
   * REVIEW-P2C14 BLOCKING 3:
   *   - School admin / `beh-001:admin` holder: any student in school.
   *   - Teacher (STAFF with employeeId): only students they teach via
   *     sis_class_teachers + sis_enrollments (ACTIVE).
   *   - Student (STUDENT): only own balance, resolved via the
   *     platform_students.person_id chain.
   *   - Guardian (GUARDIAN): only linked children via
   *     sis_student_guardians.
   *   - Everyone else: 403.
   * Without this gate, any actor with beh-001:read could enumerate the
   * positive-points ledger of any student in the school.
   */
  async getStudentBalance(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<PointsBalanceResponseDto> {
    const tenant = getCurrentTenant();
    await this.assertCanReadBalance(studentId, actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const totals = (await client.$queryRawUnsafe(
        'SELECT ' +
          "  COALESCE(SUM(CASE WHEN transaction_type = 'AWARD' THEN points ELSE 0 END), 0)::int AS awarded, " +
          "  COALESCE(SUM(CASE WHEN transaction_type = 'REDEMPTION' THEN points ELSE 0 END), 0)::int AS redeemed " +
          'FROM sis_positive_behaviour_points ' +
          'WHERE school_id = $1::uuid AND student_id = $2::uuid',
        tenant.schoolId,
        studentId,
      )) as Array<{ awarded: number; redeemed: number }>;
      const awarded = totals[0]?.awarded ?? 0;
      const redeemed = totals[0]?.redeemed ?? 0;

      const history = (await client.$queryRawUnsafe(
        SELECT_TX_BASE +
          'WHERE pp.school_id = $1::uuid AND pp.student_id = $2::uuid ' +
          'ORDER BY pp.awarded_at DESC LIMIT 100',
        tenant.schoolId,
        studentId,
      )) as TransactionRow[];

      return {
        studentId,
        awarded,
        redeemed,
        balance: awarded - redeemed,
        history: history.map(rowToTxDto),
      };
    });
  }

  // ── Rewards marketplace ────────────────────────────────────────

  async listRewards(includeInactive = false): Promise<BehaviourRewardResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_REWARD_BASE + 'WHERE school_id = $1::uuid ';
      if (!includeInactive) sql += 'AND is_active = true ';
      sql += 'ORDER BY points_cost ASC, reward_name ASC';
      const rows = (await client.$queryRawUnsafe(sql, tenant.schoolId)) as RewardRow[];
      return rows.map(rowToRewardDto);
    });
  }

  async createReward(
    input: CreateRewardDto,
    actor: ResolvedActor,
  ): Promise<BehaviourRewardResponseDto> {
    if (!(await this.hasRewardAdminScope(actor))) {
      throw new ForbiddenException('Only admins can create rewards');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sis_behaviour_rewards ' +
            '(id, school_id, reward_name, description, points_cost, reward_type, quantity_available) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
          id,
          tenant.schoolId,
          input.rewardName,
          input.description ?? null,
          input.pointsCost,
          input.rewardType,
          input.quantityAvailable ?? null,
        );
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('sis_beh_reward_name_uq')) {
        throw new ConflictException('A reward with this name already exists for this school');
      }
      throw err;
    }
    return this.getRewardById(id);
  }

  async updateReward(
    id: string,
    input: UpdateRewardDto,
    actor: ResolvedActor,
  ): Promise<BehaviourRewardResponseDto> {
    if (!(await this.hasRewardAdminScope(actor))) {
      throw new ForbiddenException('Only admins can update rewards');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const cur = (await tx.$queryRawUnsafe(
        'SELECT id FROM sis_behaviour_rewards WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (cur.length === 0) throw new NotFoundException('Reward not found');
      await tx.$executeRawUnsafe(
        'UPDATE sis_behaviour_rewards SET ' +
          'description = COALESCE($1, description), ' +
          'points_cost = COALESCE($2::int, points_cost), ' +
          'quantity_available = $3::int, ' +
          'is_active = COALESCE($4::boolean, is_active), ' +
          'updated_at = now() ' +
          'WHERE school_id = $5::uuid AND id = $6::uuid',
        input.description ?? null,
        input.pointsCost ?? null,
        input.quantityAvailable === undefined ? null : input.quantityAvailable,
        input.isActive ?? null,
        tenant.schoolId,
        id,
      );
    });
    return this.getRewardById(id);
  }

  async getRewardById(id: string): Promise<BehaviourRewardResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_REWARD_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as RewardRow[];
      const first = rows[0];
      if (!first) throw new NotFoundException('Reward not found');
      return rowToRewardDto(first);
    });
  }

  /**
   * Student redeems a reward. Validates balance + quantity_available
   * inside a locked tenant tx. The lock on the reward row serialises
   * concurrent redeems so quantity_available cannot go negative.
   * Mirrors the Cycle 6 InvoiceService.pay locked-row pattern.
   */
  async redeem(
    rewardId: string,
    input: RedeemRewardDto,
    actor: ResolvedActor,
  ): Promise<RedemptionResponseDto> {
    const tenant = getCurrentTenant();
    // Students can redeem own; counsellor/admin can redeem on behalf
    const isAdmin = await this.hasRewardAdminScope(actor);
    if (!isAdmin) {
      // For non-admins, the studentId must match the actor's own student
      // record via the platform_students chain. We resolve in a single
      // SQL query.
      const ownStudent = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const rows = (await client.$queryRawUnsafe(
          'SELECT s.id::text AS id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.school_id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
          tenant.schoolId,
          actor.personId,
        )) as Array<{ id: string }>;
        return rows[0]?.id ?? null;
      });
      if (!ownStudent || ownStudent !== input.studentId) {
        throw new ForbiddenException(
          'Students can only redeem rewards for themselves; admins can redeem on behalf',
        );
      }
    }

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the reward row first
      const reward = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, reward_name, points_cost, quantity_available, is_active ' +
          'FROM sis_behaviour_rewards WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        rewardId,
      )) as Array<{
        id: string;
        reward_name: string;
        points_cost: number;
        quantity_available: number | null;
        is_active: boolean;
      }>;
      const r = reward[0];
      if (!r) throw new NotFoundException('Reward not found');
      if (!r.is_active) {
        throw new BadRequestException('Reward is no longer active');
      }
      if (r.quantity_available !== null && r.quantity_available <= 0) {
        throw new ConflictException('Reward is out of stock');
      }

      // Validate student
      const stu = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM sis_students WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        input.studentId,
      )) as Array<{ id: string }>;
      if (stu.length === 0) {
        throw new BadRequestException('studentId does not match a student in this school');
      }

      // Compute balance under the same lock
      const totals = (await tx.$queryRawUnsafe(
        'SELECT ' +
          "  COALESCE(SUM(CASE WHEN transaction_type = 'AWARD' THEN points ELSE 0 END), 0)::int AS awarded, " +
          "  COALESCE(SUM(CASE WHEN transaction_type = 'REDEMPTION' THEN points ELSE 0 END), 0)::int AS redeemed " +
          'FROM sis_positive_behaviour_points ' +
          'WHERE school_id = $1::uuid AND student_id = $2::uuid',
        tenant.schoolId,
        input.studentId,
      )) as Array<{ awarded: number; redeemed: number }>;
      const balance = (totals[0]?.awarded ?? 0) - (totals[0]?.redeemed ?? 0);
      if (balance < r.points_cost) {
        throw new BadRequestException(
          'Insufficient point balance: ' + balance + ' available, ' + r.points_cost + ' required',
        );
      }

      // Insert the REDEMPTION transaction
      const txId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO sis_positive_behaviour_points ' +
          '(id, school_id, student_id, awarded_by, transaction_type, points, reason, reward_id) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid)',
        txId,
        tenant.schoolId,
        input.studentId,
        actor.employeeId ?? null,
        'REDEMPTION',
        r.points_cost,
        'Redeemed ' + r.reward_name,
        rewardId,
      );

      // Decrement quantity_available if set. REVIEW-P2C14 MAJOR 7 — carry
      // school_id predicate for consistency with the rest of the redemption
      // tx; the prior FOR UPDATE lock already verified school ownership.
      if (r.quantity_available !== null) {
        await tx.$executeRawUnsafe(
          'UPDATE sis_behaviour_rewards SET quantity_available = quantity_available - 1, updated_at = now() ' +
            'WHERE school_id = $1::uuid AND id = $2::uuid',
          tenant.schoolId,
          rewardId,
        );
      }

      return {
        transactionId: txId,
        rewardId,
        rewardName: r.reward_name,
        pointsSpent: r.points_cost,
        newBalance: balance - r.points_cost,
      };
    });
  }
}
