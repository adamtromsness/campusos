import { BadRequestException, Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { assertEngagementAdmin, assertEngagementReader } from './access';
import type {
  EngagementLevel,
  EngagementLevelThresholds,
  EngagementScoreDto,
  EngagementScoreWeights,
  EngagementSummaryDto,
  UpdateScoreConfigDto,
} from './dto/engagement.dto';

interface ScoreRow {
  id: string;
  school_id: string;
  family_account_id: string;
  score_date: string;
  composite_score: number;
  attendance_component: number | null;
  communication_component: number | null;
  conference_component: number | null;
  volunteer_component: number | null;
  payment_component: number | null;
  engagement_level: string;
  component_weights: unknown;
  notes: string | null;
  computed_at: string;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_WEIGHTS: EngagementScoreWeights = {
  attendance: 20,
  communication: 25,
  conference: 25,
  volunteer: 15,
  payment: 15,
};

export const DEFAULT_THRESHOLDS: EngagementLevelThresholds = {
  highlyEngaged: 75,
  engaged: 50,
  minimal: 25,
};

const WEIGHTS_CONFIG_KEY = 'engagement_score_weights';
const THRESHOLDS_CONFIG_KEY = 'engagement_level_thresholds';

@Injectable()
export class EngagementScoreService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toDto(row: ScoreRow): EngagementScoreDto {
    let weights: Record<string, number> | null = null;
    if (row.component_weights && typeof row.component_weights === 'object') {
      weights = row.component_weights as Record<string, number>;
    } else if (typeof row.component_weights === 'string') {
      try {
        weights = JSON.parse(row.component_weights);
      } catch {
        weights = null;
      }
    }
    return {
      id: row.id,
      schoolId: row.school_id,
      familyAccountId: row.family_account_id,
      scoreDate: row.score_date,
      compositeScore: Number(row.composite_score),
      attendanceComponent:
        row.attendance_component === null ? null : Number(row.attendance_component),
      communicationComponent:
        row.communication_component === null ? null : Number(row.communication_component),
      conferenceComponent:
        row.conference_component === null ? null : Number(row.conference_component),
      volunteerComponent: row.volunteer_component === null ? null : Number(row.volunteer_component),
      paymentComponent: row.payment_component === null ? null : Number(row.payment_component),
      engagementLevel: row.engagement_level as EngagementLevel,
      componentWeights: weights,
      notes: row.notes,
      computedAt: row.computed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(
    actor: ResolvedActor,
    filters: { level?: EngagementLevel; scoreDate?: string } = {},
  ): Promise<EngagementScoreDto[]> {
    await assertEngagementReader(actor, this.permCheck, 'Listing engagement scores');
    const tenant = getCurrentTenant();
    const args: unknown[] = [tenant.schoolId];
    let where = ' WHERE school_id = $1::uuid';
    if (filters.level) {
      args.push(filters.level);
      where += ' AND engagement_level = $' + args.length;
    }
    if (filters.scoreDate) {
      args.push(filters.scoreDate);
      where += ' AND score_date = $' + args.length + '::date';
    } else {
      // Default: latest score per family across the school
      where += ` AND score_date = (SELECT MAX(score_date) FROM eng_family_engagement_scores WHERE school_id = $1::uuid)`;
    }
    const sql =
      `SELECT id::text AS id, school_id::text AS school_id,
              family_account_id::text AS family_account_id,
              score_date::text AS score_date, composite_score,
              attendance_component, communication_component, conference_component,
              volunteer_component, payment_component, engagement_level,
              component_weights, notes,
              computed_at::text AS computed_at,
              created_at::text AS created_at, updated_at::text AS updated_at
       FROM eng_family_engagement_scores` +
      where +
      ' ORDER BY composite_score DESC';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...args);
    })) as ScoreRow[];
    return rows.map((r) => this.toDto(r));
  }

  async getForFamily(actor: ResolvedActor, familyAccountId: string): Promise<EngagementScoreDto[]> {
    await assertEngagementReader(actor, this.permCheck, 'Reading family engagement history');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id,
                family_account_id::text AS family_account_id,
                score_date::text AS score_date, composite_score,
                attendance_component, communication_component, conference_component,
                volunteer_component, payment_component, engagement_level,
                component_weights, notes,
                computed_at::text AS computed_at,
                created_at::text AS created_at, updated_at::text AS updated_at
         FROM eng_family_engagement_scores
         WHERE school_id = $1::uuid AND family_account_id = $2::uuid
         ORDER BY score_date DESC`,
        tenant.schoolId,
        familyAccountId,
      );
    })) as ScoreRow[];
    return rows.map((r) => this.toDto(r));
  }

  async summary(actor: ResolvedActor): Promise<EngagementSummaryDto> {
    await assertEngagementReader(actor, this.permCheck, 'Reading engagement summary');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `WITH latest AS (
           SELECT family_account_id,
                  composite_score, engagement_level,
                  score_date,
                  ROW_NUMBER() OVER (PARTITION BY family_account_id ORDER BY score_date DESC) AS rn
           FROM eng_family_engagement_scores
           WHERE school_id = $1::uuid
         )
         SELECT engagement_level, composite_score, score_date::text AS score_date
         FROM latest
         WHERE rn = 1`,
        tenant.schoolId,
      );
    })) as Array<{ engagement_level: string; composite_score: number; score_date: string }>;

    const byLevel: Record<EngagementLevel, number> = {
      HIGHLY_ENGAGED: 0,
      ENGAGED: 0,
      MINIMAL: 0,
      AT_RISK: 0,
    };
    let sum = 0;
    let mostRecentDate: string | null = null;
    for (const r of rows) {
      byLevel[r.engagement_level as EngagementLevel] += 1;
      sum += Number(r.composite_score);
      if (!mostRecentDate || r.score_date > mostRecentDate) {
        mostRecentDate = r.score_date;
      }
    }
    const totalFamilies = rows.length;
    const averageScore = totalFamilies === 0 ? 0 : Math.round((sum / totalFamilies) * 10) / 10;
    return {
      totalFamilies,
      byLevel,
      averageScore,
      scoreDate: mostRecentDate,
    };
  }

  async loadWeights(): Promise<EngagementScoreWeights> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT config_value FROM school_config WHERE config_key = $1 LIMIT 1`,
        WEIGHTS_CONFIG_KEY,
      );
    })) as Array<{ config_value: unknown }>;
    if (rows.length === 0) return { ...DEFAULT_WEIGHTS };
    const raw = rows[0]!.config_value;
    const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw;
    return mergeWeights(parsed);
  }

  async loadThresholds(): Promise<EngagementLevelThresholds> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT config_value FROM school_config WHERE config_key = $1 LIMIT 1`,
        THRESHOLDS_CONFIG_KEY,
      );
    })) as Array<{ config_value: unknown }>;
    if (rows.length === 0) return { ...DEFAULT_THRESHOLDS };
    const raw = rows[0]!.config_value;
    const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw;
    return mergeThresholds(parsed);
  }

  async getConfig(actor: ResolvedActor): Promise<{
    weights: EngagementScoreWeights;
    thresholds: EngagementLevelThresholds;
  }> {
    await assertEngagementReader(actor, this.permCheck, 'Reading engagement score config');
    return {
      weights: await this.loadWeights(),
      thresholds: await this.loadThresholds(),
    };
  }

  async updateConfig(
    actor: ResolvedActor,
    input: UpdateScoreConfigDto,
  ): Promise<{ weights: EngagementScoreWeights; thresholds: EngagementLevelThresholds }> {
    await assertEngagementAdmin(actor, this.permCheck, 'Updating engagement score config');

    if (input.weights) {
      const merged = mergeWeights({ ...(await this.loadWeights()), ...input.weights });
      const sum =
        merged.attendance +
        merged.communication +
        merged.conference +
        merged.volunteer +
        merged.payment;
      if (Math.abs(sum - 100) > 0.5) {
        throw new BadRequestException(`Score weights must sum to 100. Provided sum=${sum}.`);
      }
      await this.upsertConfig(WEIGHTS_CONFIG_KEY, merged, 'Engagement score component weights.');
    }
    if (input.thresholds) {
      const merged = mergeThresholds({
        ...(await this.loadThresholds()),
        ...input.thresholds,
      });
      if (
        !(
          merged.highlyEngaged > merged.engaged &&
          merged.engaged > merged.minimal &&
          merged.minimal >= 0 &&
          merged.highlyEngaged <= 100
        )
      ) {
        throw new BadRequestException(
          'Thresholds must satisfy highlyEngaged > engaged > minimal >= 0 and highlyEngaged <= 100',
        );
      }
      await this.upsertConfig(
        THRESHOLDS_CONFIG_KEY,
        merged,
        'Engagement level threshold boundaries.',
      );
    }
    return {
      weights: await this.loadWeights(),
      thresholds: await this.loadThresholds(),
    };
  }

  private async upsertConfig(key: string, value: object, description: string): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO school_config (id, config_key, config_value, description)
         VALUES ($1::uuid, $2, $3::jsonb, $4)
         ON CONFLICT (config_key)
         DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = now()`,
        generateId(),
        key,
        JSON.stringify(value),
        description,
      );
    });
  }

  /**
   * Persist a single engagement-score row. Used by the
   * EngagementScoreWorker. Idempotent via UNIQUE(family_account_id,
   * score_date) — UPSERTs replace the row when re-materialised.
   */
  async upsertScore(input: {
    schoolId: string;
    familyAccountId: string;
    scoreDate: string;
    components: {
      attendance: number;
      communication: number;
      conference: number;
      volunteer: number;
      payment: number;
    };
    weights: EngagementScoreWeights;
    thresholds: EngagementLevelThresholds;
    client?: unknown;
  }): Promise<{ compositeScore: number; engagementLevel: EngagementLevel }> {
    const composite = computeCompositeScore(input.components, input.weights);
    const level = resolveEngagementLevel(composite, input.thresholds);

    const exec = async (tx: {
      $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    }): Promise<void> => {
      await tx.$executeRawUnsafe(
        `INSERT INTO eng_family_engagement_scores
           (id, school_id, family_account_id, score_date, composite_score,
            attendance_component, communication_component, conference_component,
            volunteer_component, payment_component, engagement_level,
            component_weights, computed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5,
                 $6, $7, $8, $9, $10, $11, $12::jsonb, now())
         ON CONFLICT (family_account_id, score_date) DO UPDATE
           SET composite_score = EXCLUDED.composite_score,
               attendance_component = EXCLUDED.attendance_component,
               communication_component = EXCLUDED.communication_component,
               conference_component = EXCLUDED.conference_component,
               volunteer_component = EXCLUDED.volunteer_component,
               payment_component = EXCLUDED.payment_component,
               engagement_level = EXCLUDED.engagement_level,
               component_weights = EXCLUDED.component_weights,
               computed_at = now(),
               updated_at = now()`,
        generateId(),
        input.schoolId,
        input.familyAccountId,
        input.scoreDate,
        composite,
        input.components.attendance,
        input.components.communication,
        input.components.conference,
        input.components.volunteer,
        input.components.payment,
        level,
        JSON.stringify(input.weights),
      );
    };

    if (input.client) {
      await exec(
        input.client as {
          $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
        },
      );
    } else {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await exec(client);
      });
    }
    return { compositeScore: composite, engagementLevel: level };
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function mergeWeights(raw: unknown): EngagementScoreWeights {
  const out: EngagementScoreWeights = { ...DEFAULT_WEIGHTS };
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.attendance === 'number') out.attendance = o.attendance;
    if (typeof o.communication === 'number') out.communication = o.communication;
    if (typeof o.conference === 'number') out.conference = o.conference;
    if (typeof o.volunteer === 'number') out.volunteer = o.volunteer;
    if (typeof o.payment === 'number') out.payment = o.payment;
  }
  return out;
}

function mergeThresholds(raw: unknown): EngagementLevelThresholds {
  const out: EngagementLevelThresholds = { ...DEFAULT_THRESHOLDS };
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.highlyEngaged === 'number') out.highlyEngaged = o.highlyEngaged;
    if (typeof o.engaged === 'number') out.engaged = o.engaged;
    if (typeof o.minimal === 'number') out.minimal = o.minimal;
    // Tolerate legacy snake_case keys
    if (typeof (o as Record<string, unknown>).highly_engaged === 'number') {
      out.highlyEngaged = (o as Record<string, number>).highly_engaged!;
    }
  }
  return out;
}

export function computeCompositeScore(
  components: {
    attendance: number;
    communication: number;
    conference: number;
    volunteer: number;
    payment: number;
  },
  weights: EngagementScoreWeights,
): number {
  const totalWeight =
    weights.attendance +
    weights.communication +
    weights.conference +
    weights.volunteer +
    weights.payment;
  if (totalWeight <= 0) return 0;
  const weighted =
    clamp(components.attendance) * weights.attendance +
    clamp(components.communication) * weights.communication +
    clamp(components.conference) * weights.conference +
    clamp(components.volunteer) * weights.volunteer +
    clamp(components.payment) * weights.payment;
  return Math.round(weighted / totalWeight);
}

export function resolveEngagementLevel(
  composite: number,
  thresholds: EngagementLevelThresholds,
): EngagementLevel {
  if (composite >= thresholds.highlyEngaged) return 'HIGHLY_ENGAGED';
  if (composite >= thresholds.engaged) return 'ENGAGED';
  if (composite >= thresholds.minimal) return 'MINIMAL';
  return 'AT_RISK';
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}
