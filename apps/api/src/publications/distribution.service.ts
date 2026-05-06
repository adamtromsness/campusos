import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type {
  AudiencePreviewDto,
  CreateDistributionListDto,
  CreateDistributionRuleDto,
  DeliveryStatus,
  DistributionListDto,
  DistributionRuleDto,
  DistributionRuleType,
  DistributionStatusDto,
  SubscriptionDto,
  SubscriptionStatus,
} from './dto/publications.dto';

@Injectable()
export class DistributionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  private async assertDistributor(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'pub-003:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only distribution managers or school admins can manage distribution.',
      );
    }
  }

  async listForPublication(publicationId: string): Promise<DistributionListDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, publication_id::text AS publication_id, list_name, is_active FROM pub_distribution_lists WHERE publication_id = $1::uuid ORDER BY created_at',
        publicationId,
      );
    })) as Array<{ id: string; publication_id: string; list_name: string; is_active: boolean }>;
    const out: DistributionListDto[] = [];
    for (const r of rows) {
      const rules = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT id::text AS id, distribution_list_id::text AS distribution_list_id, rule_type, rule_value FROM pub_distribution_rules WHERE distribution_list_id = $1::uuid ORDER BY created_at',
          r.id,
        );
      })) as DistributionRuleDto[];
      out.push({
        id: r.id,
        publicationId: r.publication_id,
        listName: r.list_name,
        isActive: r.is_active,
        rules,
      });
    }
    return out;
  }

  async createList(
    actor: ResolvedActor,
    publicationId: string,
    input: CreateDistributionListDto,
  ): Promise<DistributionListDto> {
    await this.assertDistributor(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const exists = (await client.$queryRawUnsafe(
        'SELECT 1 FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        publicationId,
        tenant.schoolId,
      )) as Array<unknown>;
      if (exists.length === 0) throw new NotFoundException('Publication not found');
      const listId = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO pub_distribution_lists (id, publication_id, list_name) VALUES ($1::uuid, $2::uuid, $3)',
        listId,
        publicationId,
        input.listName,
      );
      for (const rule of input.rules ?? []) {
        await client.$executeRawUnsafe(
          'INSERT INTO pub_distribution_rules (id, distribution_list_id, rule_type, rule_value) VALUES ($1::uuid, $2::uuid, $3, $4)',
          generateId(),
          listId,
          rule.ruleType,
          rule.ruleValue,
        );
      }
      const lists = await this.listForPublication(publicationId);
      return lists.find((l) => l.id === listId)!;
    });
  }

  async addRule(
    actor: ResolvedActor,
    listId: string,
    input: CreateDistributionRuleDto,
  ): Promise<DistributionRuleDto> {
    await this.assertDistributor(actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const exists = (await client.$queryRawUnsafe(
        'SELECT 1 FROM pub_distribution_lists WHERE id = $1::uuid LIMIT 1',
        listId,
      )) as Array<unknown>;
      if (exists.length === 0) throw new NotFoundException('Distribution list not found');
      await client.$executeRawUnsafe(
        'INSERT INTO pub_distribution_rules (id, distribution_list_id, rule_type, rule_value) VALUES ($1::uuid, $2::uuid, $3, $4)',
        id,
        listId,
        input.ruleType,
        input.ruleValue,
      );
    });
    return {
      id,
      distributionListId: listId,
      ruleType: input.ruleType,
      ruleValue: input.ruleValue,
    };
  }

  // Internal — resolves the audience for a publication's distribution lists
  // by walking each rule and OR-aggregating matching account_ids. Excludes
  // accounts that have UNSUBSCRIBED from the parent series.
  private async resolveAudience(
    publicationId: string,
  ): Promise<{ accountIds: string[]; excludedUnsubscribed: number }> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const pubRows = (await client.$queryRawUnsafe(
        'SELECT series_id::text AS series_id FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        publicationId,
        tenant.schoolId,
      )) as Array<{ series_id: string | null }>;
      if (pubRows.length === 0) throw new NotFoundException('Publication not found');
      const seriesId = pubRows[0]!.series_id;

      const ruleRows = (await client.$queryRawUnsafe(
        'SELECT r.rule_type, r.rule_value FROM pub_distribution_rules r JOIN pub_distribution_lists l ON l.id = r.distribution_list_id WHERE l.publication_id = $1::uuid AND l.is_active = true',
        publicationId,
      )) as Array<{ rule_type: DistributionRuleType; rule_value: string }>;

      const matched = new Set<string>();
      for (const r of ruleRows) {
        if (r.rule_type === 'ROLE') {
          // Role token: PARENT, STAFF, STUDENT, TEACHER. Match
          // platform_users via the iam_role_assignment chain at school +
          // platform scope per ADR-036. The role.name -> token mapping is
          // UPPER(REPLACE(role.name, ' ', '_')) per the convention used
          // by Cycle 3 ThreadService and Cycle 7 WorkflowEngineService.
          const roleAccounts = (await client.$queryRawUnsafe(
            "SELECT DISTINCT ra.account_id::text AS account_id FROM platform.iam_role_assignment ra JOIN platform.roles r ON r.id = ra.role_id JOIN platform.iam_scope sc ON sc.id = ra.scope_id JOIN platform.iam_scope_type stp ON stp.id = sc.scope_type_id WHERE ra.status = 'ACTIVE' AND UPPER(REGEXP_REPLACE(r.name, '\\s+', '_', 'g')) = $1 AND ((stp.code = 'SCHOOL' AND sc.entity_id = $2::uuid) OR stp.code = 'PLATFORM')",
            r.rule_value,
            tenant.schoolId,
          )) as Array<{ account_id: string }>;
          for (const a of roleAccounts) matched.add(a.account_id);
        } else if (r.rule_type === 'GRADE') {
          // Match guardians of students in this grade — "send to grade 5 parents"
          const accounts = (await client.$queryRawUnsafe(
            'SELECT DISTINCT pu.id::text AS account_id FROM sis_students s JOIN sis_student_guardians sg ON sg.student_id = s.id JOIN sis_guardians g ON g.id = sg.guardian_id JOIN platform.platform_users pu ON pu.person_id = g.person_id WHERE s.grade_level = $1 AND g.account_id IS NOT NULL',
            r.rule_value,
          )) as Array<{ account_id: string }>;
          for (const a of accounts) matched.add(a.account_id);
        } else if (r.rule_type === 'CLASS') {
          // Class membership — students enrolled + assigned teachers.
          const students = (await client.$queryRawUnsafe(
            "SELECT DISTINCT pu.id::text AS account_id FROM sis_enrollments e JOIN sis_students s ON s.id = e.student_id JOIN platform.platform_students ps ON ps.id = s.platform_student_id JOIN platform.platform_users pu ON pu.person_id = ps.person_id WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE'",
            r.rule_value,
          )) as Array<{ account_id: string }>;
          for (const a of students) matched.add(a.account_id);
          const teachers = (await client.$queryRawUnsafe(
            'SELECT DISTINCT pu.id::text AS account_id FROM sis_class_teachers ct JOIN hr_employees emp ON emp.id = ct.teacher_employee_id JOIN platform.iam_person ip ON ip.id = emp.person_id JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE ct.class_id = $1::uuid',
            r.rule_value,
          )) as Array<{ account_id: string }>;
          for (const a of teachers) matched.add(a.account_id);
        } else if (r.rule_type === 'GROUP_MEMBERSHIP') {
          const accounts = (await client.$queryRawUnsafe(
            "SELECT DISTINCT pu.id::text AS account_id FROM grp_members m JOIN platform.iam_person ip ON ip.id = m.person_id JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE m.group_id = $1::uuid AND m.status = 'ACTIVE'",
            r.rule_value,
          )) as Array<{ account_id: string }>;
          for (const a of accounts) matched.add(a.account_id);
        }
      }

      // Exclude UNSUBSCRIBED for the series (if publication belongs to one).
      let excluded = 0;
      if (seriesId) {
        const unsub = (await client.$queryRawUnsafe(
          "SELECT subscriber_id::text AS account_id FROM pub_series_subscriptions WHERE series_id = $1::uuid AND status = 'UNSUBSCRIBED'",
          seriesId,
        )) as Array<{ account_id: string }>;
        for (const u of unsub) {
          if (matched.delete(u.account_id)) excluded += 1;
        }
      }

      return { accountIds: [...matched], excludedUnsubscribed: excluded };
    });
  }

  async previewAudience(actor: ResolvedActor, publicationId: string): Promise<AudiencePreviewDto> {
    await this.assertDistributor(actor);
    const audience = await this.resolveAudience(publicationId);
    // Sample names (up to 10)
    const sampleNames =
      audience.accountIds.length === 0
        ? []
        : await this.tenantPrisma.executeInTenantContext(async (client) => {
            const rows = (await client.$queryRawUnsafe(
              "SELECT ip.first_name || ' ' || ip.last_name AS name FROM platform.platform_users pu JOIN platform.iam_person ip ON ip.id = pu.person_id WHERE pu.id = ANY($1::uuid[]) ORDER BY ip.first_name LIMIT 10",
              audience.accountIds.slice(0, 100),
            )) as Array<{ name: string }>;
            return rows.map((r) => r.name);
          });
    return {
      totalRecipients: audience.accountIds.length,
      excludedUnsubscribed: audience.excludedUnsubscribed,
      sampleNames,
    };
  }

  // PUBLISH + DISTRIBUTE KEYSTONE — resolves the audience, INSERTs
  // pub_distribution_recipients with PENDING status (ON CONFLICT DO NOTHING
  // for redelivery idempotency), flips the publication status to PUBLISHED,
  // and emits pub.publication.published AFTER tx commits so the Cycle 14
  // Communications consumer can fan out IN_APP / EMAIL deliveries.
  async distribute(
    actor: ResolvedActor,
    publicationId: string,
  ): Promise<{ totalRecipients: number; alreadyExisted: number; status: 'PUBLISHED' }> {
    await this.assertDistributor(actor);
    const tenant = getCurrentTenant();
    const audience = await this.resolveAudience(publicationId);

    const result = await this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT title, status, series_id::text AS series_id FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        publicationId,
        tenant.schoolId,
      )) as Array<{ title: string; status: string; series_id: string | null }>;
      if (rows.length === 0) throw new NotFoundException('Publication not found');
      const cur = rows[0]!;
      if (cur.status !== 'APPROVED' && cur.status !== 'PUBLISHED') {
        throw new BadRequestException(
          `Publication must be in APPROVED status before distributing (currently ${cur.status}).`,
        );
      }
      let inserted = 0;
      const beforeRows = (await client.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS n FROM pub_distribution_recipients WHERE publication_id = $1::uuid',
        publicationId,
      )) as Array<{ n: number }>;
      const before = Number(beforeRows[0]!.n);

      for (const accountId of audience.accountIds) {
        const r = await client.$executeRawUnsafe(
          "INSERT INTO pub_distribution_recipients (id, publication_id, recipient_id, delivery_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING') ON CONFLICT (publication_id, recipient_id) DO NOTHING",
          generateId(),
          publicationId,
          accountId,
        );
        if (typeof r === 'number') inserted += r;
      }

      if (cur.status !== 'PUBLISHED') {
        await client.$executeRawUnsafe(
          "UPDATE pub_publications SET status = 'PUBLISHED', published_at = now(), updated_at = now() WHERE id = $1::uuid",
          publicationId,
        );
      }

      const afterRows = (await client.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS n FROM pub_distribution_recipients WHERE publication_id = $1::uuid',
        publicationId,
      )) as Array<{ n: number }>;
      const total = Number(afterRows[0]!.n);
      return {
        totalRecipients: total,
        alreadyExisted: before,
        title: cur.title,
        seriesId: cur.series_id,
      };
    });

    await this.kafka.emit({
      topic: 'pub.publication.published',
      key: publicationId,
      sourceModule: 'publications',
      payload: {
        publicationId,
        sourceRefId: publicationId,
        schoolId: tenant.schoolId,
        title: result.title,
        seriesId: result.seriesId,
        totalRecipients: result.totalRecipients,
        publishedById: actor.accountId,
        publishedAt: new Date().toISOString(),
      },
    });

    return {
      totalRecipients: result.totalRecipients,
      alreadyExisted: result.alreadyExisted,
      status: 'PUBLISHED',
    };
  }

  async deliveryStatus(publicationId: string): Promise<DistributionStatusDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT delivery_status, COUNT(*)::int AS n FROM pub_distribution_recipients WHERE publication_id = $1::uuid GROUP BY delivery_status',
        publicationId,
      );
    })) as Array<{ delivery_status: DeliveryStatus; n: number }>;
    const out: DistributionStatusDto = {
      publicationId,
      totalRecipients: 0,
      pending: 0,
      delivered: 0,
      opened: 0,
      bounced: 0,
    };
    for (const r of rows) {
      out.totalRecipients += Number(r.n);
      if (r.delivery_status === 'PENDING') out.pending = Number(r.n);
      else if (r.delivery_status === 'DELIVERED') out.delivered = Number(r.n);
      else if (r.delivery_status === 'OPENED') out.opened = Number(r.n);
      else if (r.delivery_status === 'BOUNCED') out.bounced = Number(r.n);
    }
    return out;
  }
}

@Injectable()
export class SubscriptionService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listForSeries(seriesId: string): Promise<SubscriptionDto[]> {
    return this.querySubscriptions(
      'WHERE sub.series_id = $1::uuid ORDER BY sub.subscribed_at DESC',
      [seriesId],
    );
  }

  async myList(actor: ResolvedActor): Promise<SubscriptionDto[]> {
    return this.querySubscriptions(
      'WHERE sub.subscriber_id = $1::uuid ORDER BY sub.subscribed_at DESC',
      [actor.accountId],
    );
  }

  private async querySubscriptions(
    whereClause: string,
    params: unknown[],
  ): Promise<SubscriptionDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT sub.id::text AS id, sub.series_id::text AS series_id, (SELECT title FROM pub_series s WHERE s.id = sub.series_id LIMIT 1) AS series_title, sub.subscriber_id::text AS subscriber_id, (SELECT ip.first_name || ' ' || ip.last_name FROM platform.platform_users pu JOIN platform.iam_person ip ON ip.id = pu.person_id WHERE pu.id = sub.subscriber_id LIMIT 1) AS subscriber_name, sub.status, sub.subscribed_at::text AS subscribed_at, sub.unsubscribed_at::text AS unsubscribed_at FROM pub_series_subscriptions sub " +
          whereClause,
        ...params,
      );
    })) as Array<{
      id: string;
      series_id: string;
      series_title: string | null;
      subscriber_id: string;
      subscriber_name: string | null;
      status: SubscriptionStatus;
      subscribed_at: string;
      unsubscribed_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      seriesId: r.series_id,
      seriesTitle: r.series_title,
      subscriberId: r.subscriber_id,
      subscriberName: r.subscriber_name,
      status: r.status,
      subscribedAt: r.subscribed_at,
      unsubscribedAt: r.unsubscribed_at,
    }));
  }

  async subscribe(actor: ResolvedActor, seriesId: string): Promise<SubscriptionDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      // Idempotent: if already subscribed, no-op. If unsubscribed, re-subscribe.
      const existing = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM pub_series_subscriptions WHERE series_id = $1::uuid AND subscriber_id = $2::uuid LIMIT 1',
        seriesId,
        actor.accountId,
      )) as Array<{ id: string; status: SubscriptionStatus }>;
      if (existing.length > 0) {
        if (existing[0]!.status === 'UNSUBSCRIBED') {
          await client.$executeRawUnsafe(
            "UPDATE pub_series_subscriptions SET status = 'SUBSCRIBED', subscribed_at = now(), unsubscribed_at = NULL WHERE id = $1::uuid",
            existing[0]!.id,
          );
        }
      } else {
        await client.$executeRawUnsafe(
          "INSERT INTO pub_series_subscriptions (id, series_id, subscriber_id, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBSCRIBED')",
          generateId(),
          seriesId,
          actor.accountId,
        );
      }
      const out = await this.querySubscriptions(
        'WHERE sub.series_id = $1::uuid AND sub.subscriber_id = $2::uuid LIMIT 1',
        [seriesId, actor.accountId],
      );
      return out[0]!;
    });
  }

  async unsubscribe(actor: ResolvedActor, seriesId: string): Promise<SubscriptionDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const existing = (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM pub_series_subscriptions WHERE series_id = $1::uuid AND subscriber_id = $2::uuid LIMIT 1',
        seriesId,
        actor.accountId,
      )) as Array<{ id: string }>;
      if (existing.length > 0) {
        await client.$executeRawUnsafe(
          "UPDATE pub_series_subscriptions SET status = 'UNSUBSCRIBED', unsubscribed_at = now() WHERE id = $1::uuid",
          existing[0]!.id,
        );
      } else {
        await client.$executeRawUnsafe(
          "INSERT INTO pub_series_subscriptions (id, series_id, subscriber_id, status, unsubscribed_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'UNSUBSCRIBED', now())",
          generateId(),
          seriesId,
          actor.accountId,
        );
      }
      const out = await this.querySubscriptions(
        'WHERE sub.series_id = $1::uuid AND sub.subscriber_id = $2::uuid LIMIT 1',
        [seriesId, actor.accountId],
      );
      return out[0]!;
    });
  }
}
