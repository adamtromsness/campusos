import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { PositiveCategoryConfig, UpdatePositiveCategoriesDto } from './dto/behaviour-advanced.dto';

const CONFIG_KEY = 'positive_behaviour_categories';

const DEFAULT_CATEGORIES: PositiveCategoryConfig[] = [
  { name: 'Respect', description: 'Kindness, courtesy, helpfulness', defaultPoints: 5 },
  {
    name: 'Responsibility',
    description: 'On time, prepared, follow through',
    defaultPoints: 5,
  },
  { name: 'Leadership', description: 'Initiative, peer support', defaultPoints: 10 },
];

/**
 * CategoryConfigService (P2-14 Step 8).
 *
 * Backs the school-configurable positive_behaviour_categories list via
 * the existing tenant-scoped `school_config` table (no new tenant
 * table per the plan — the plan referred to `platform_tenant_configs`
 * which does not exist; tenant-scoped school_config is the canonical
 * key/value JSONB config home and was established in Cycle 0).
 *
 * Read open to anyone with beh-001:read. Update gated on admin.
 */
@Injectable()
export class CategoryConfigService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'beh-001:admin',
    ]);
  }

  async list(): Promise<PositiveCategoryConfig[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT config_value FROM school_config WHERE config_key = $1 LIMIT 1',
        CONFIG_KEY,
      )) as Array<{ config_value: unknown }>;
      const first = rows[0];
      if (!first) return DEFAULT_CATEGORIES;
      const v = first.config_value;
      if (Array.isArray(v)) return v as PositiveCategoryConfig[];
      return DEFAULT_CATEGORIES;
    });
  }

  async update(
    input: UpdatePositiveCategoriesDto,
    actor: ResolvedActor,
  ): Promise<PositiveCategoryConfig[]> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Only admins can update positive behaviour categories');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO school_config (id, config_key, config_value, description, updated_by, created_at, updated_at) ' +
          'VALUES (gen_random_uuid(), $1, $2::jsonb, $3, NULL, now(), now()) ' +
          'ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = now()',
        CONFIG_KEY,
        JSON.stringify(input.categories),
        'Positive behaviour categories for behaviour-advanced module (P2-14)',
      );
    });
    return input.categories;
  }
}
