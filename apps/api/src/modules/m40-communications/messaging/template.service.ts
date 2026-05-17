import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreateTemplateDto,
  RenderTemplateDto,
  RenderedTemplateDto,
  TemplateAnalyticsDto,
  TemplateCategory,
  TemplateDto,
  TemplateUsageDto,
  TemplateVariableDto,
  UpdateTemplateDto,
  UseTemplateDto,
} from './dto/communications-advanced.dto';

interface TemplateRow {
  id: string;
  school_id: string;
  name: string;
  category: TemplateCategory;
  subject_template: string | null;
  body_template: string;
  variables: unknown;
  allowed_roles: string[];
  is_active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface UsageRow {
  id: string;
  template_id: string;
  used_by: string;
  used_at: string;
  broadcast_id: string | null;
  thread_id: string | null;
  rendered_subject: string | null;
}

function normaliseVariables(raw: unknown): TemplateVariableDto[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplateVariableDto[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name : null;
    if (!name) continue;
    out.push({
      name,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      required: typeof obj.required === 'boolean' ? obj.required : false,
      defaultValue:
        typeof obj.defaultValue === 'string'
          ? obj.defaultValue
          : typeof obj.default_value === 'string'
            ? (obj.default_value as string)
            : undefined,
    });
  }
  return out;
}

function rowToDto(row: TemplateRow): TemplateDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    name: row.name,
    category: row.category,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
    variables: normaliseVariables(row.variables),
    allowedRoles: row.allowed_roles ?? [],
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function usageToDto(row: UsageRow): TemplateUsageDto {
  return {
    id: row.id,
    templateId: row.template_id,
    usedBy: row.used_by,
    usedAt: row.used_at,
    broadcastId: row.broadcast_id,
    threadId: row.thread_id,
    renderedSubject: row.rendered_subject,
  };
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

/**
 * Interpolate {variable_name} placeholders in a template string. Used
 * by render() and use() — exported for the spec test.
 */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
    const v = values[name];
    return v === undefined || v === null ? `{${name}}` : v;
  });
}

/**
 * TemplateService — reusable message templates with variable
 * interpolation, role-scoped access, and usage analytics.
 *
 * Authorisation model:
 *   - Read: any caller whose IAM role token appears in `allowed_roles`
 *     OR who is school admin (sch-001:admin). The controller gates on
 *     com-001:read; this service applies the per-template role filter.
 *   - Write: school admin only — the controller gates on
 *     com-002:write at the route level since templates are an admin
 *     publishing surface.
 *
 * Render contract (KEYSTONE):
 *   render(templateId, values) — interpolates {name} placeholders in
 *   both `subject_template` (optional) and `body_template`. Required
 *   variables without a provided value AND without a default_value
 *   fail with 400 carrying the offending names. This is the contract
 *   the CRITICAL note pins.
 *
 * Use endpoint:
 *   - Renders the template
 *   - Writes a row to msg_template_usage_log with optional
 *     broadcast_id / thread_id linkage so the analytics endpoint can
 *     surface usage by surface and recency.
 */
@Injectable()
export class TemplateService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * List templates visible to the actor. School admins see all (incl.
   * inactive when includeInactive=true). Non-admin readers see only
   * templates whose `allowed_roles` array overlaps with the caller's
   * IAM role tokens. The role-token list is derived from the
   * persona — STAFF maps to TEACHER, GUARDIAN to PARENT, STUDENT to
   * STUDENT, plus SCHOOL_ADMIN for admins. Templates with an empty
   * allowed_roles array are visible to every authenticated caller.
   */
  async list(
    actor: ResolvedActor,
    args: { category?: TemplateCategory; includeInactive?: boolean } = {},
  ): Promise<TemplateDto[]> {
    const tenant = getCurrentTenant();
    const roleTokens = this.roleTokensFor(actor);
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const params: unknown[] = [tenant.schoolId];
      let sql =
        'SELECT id::text AS id, school_id::text AS school_id, name, category, ' +
        'subject_template, body_template, variables, allowed_roles, is_active, ' +
        'created_by::text AS created_by, created_at::text AS created_at, ' +
        'updated_at::text AS updated_at ' +
        'FROM msg_templates WHERE school_id = $1::uuid';
      if (!args.includeInactive) {
        sql += ' AND is_active = true';
      }
      if (args.category) {
        params.push(args.category);
        sql += ` AND category = $${params.length}`;
      }
      // Non-admin: row-scope by allowed_roles overlap or empty array.
      if (!actor.isSchoolAdmin) {
        params.push(roleTokens);
        sql += ` AND (cardinality(allowed_roles) = 0 OR allowed_roles && $${params.length}::text[])`;
      }
      sql += ' ORDER BY name ASC';
      const rows = await client.$queryRawUnsafe<TemplateRow[]>(sql, ...params);
      return rows.map(rowToDto);
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<TemplateDto> {
    const tenant = getCurrentTenant();
    const roleTokens = this.roleTokensFor(actor);
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<TemplateRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, name, category, ' +
          'subject_template, body_template, variables, allowed_roles, is_active, ' +
          'created_by::text AS created_by, created_at::text AS created_at, ' +
          'updated_at::text AS updated_at ' +
          'FROM msg_templates WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Template not found');
      const row = rows[0]!;
      // Row-scope: non-admin must overlap allowed_roles OR template must
      // have an open allowed_roles=[].
      if (!actor.isSchoolAdmin) {
        const allowed = row.allowed_roles ?? [];
        const open = allowed.length === 0;
        const hit = roleTokens.some((t) => allowed.includes(t));
        if (!open && !hit) throw new NotFoundException('Template not found');
      }
      return rowToDto(row);
    });
  }

  async create(input: CreateTemplateDto, actor: ResolvedActor): Promise<TemplateDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can create message templates.');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    const variables = (input.variables ?? []).map(this.variableToJson);
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO msg_templates ' +
            '(id, school_id, name, category, subject_template, body_template, ' +
            'variables, allowed_roles, is_active, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::text[], $9, $10::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.category,
          input.subjectTemplate ?? null,
          input.bodyTemplate,
          JSON.stringify(variables),
          input.allowedRoles ?? [],
          input.isActive ?? true,
          actor.accountId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'A template named "' + input.name + '" already exists in this school.',
          );
        }
        throw err;
      }
      // REVIEW-P2C19 MAJOR 3: reload carries school_id predicate as
      // belt-and-braces — the INSERT above was scoped to the calling
      // tenant via tenant.schoolId, but reload-by-id alone would still
      // accept a row from another tenant if the UUID collided.
      const rows = await tx.$queryRawUnsafe<TemplateRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, name, category, ' +
          'subject_template, body_template, variables, allowed_roles, is_active, ' +
          'created_by::text AS created_by, created_at::text AS created_at, ' +
          'updated_at::text AS updated_at ' +
          'FROM msg_templates WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
      return rowToDto(rows[0]!);
    });
  }

  async patch(id: string, input: UpdateTemplateDto, actor: ResolvedActor): Promise<TemplateDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can edit message templates.');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const lock = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM msg_templates ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      );
      if (lock.length === 0) throw new NotFoundException('Template not found');

      const sets: string[] = [];
      const params: unknown[] = [];
      function set(col: string, val: unknown, cast?: string): void {
        params.push(val);
        sets.push(col + ' = $' + params.length + (cast ? '::' + cast : ''));
      }
      if (input.name !== undefined) set('name', input.name);
      if (input.category !== undefined) set('category', input.category);
      if (input.subjectTemplate !== undefined) set('subject_template', input.subjectTemplate);
      if (input.bodyTemplate !== undefined) set('body_template', input.bodyTemplate);
      if (input.variables !== undefined) {
        const variables = input.variables.map(this.variableToJson);
        set('variables', JSON.stringify(variables), 'jsonb');
      }
      if (input.allowedRoles !== undefined) set('allowed_roles', input.allowedRoles, 'text[]');
      if (input.isActive !== undefined) set('is_active', input.isActive);
      sets.push('updated_at = now()');

      // REVIEW-P2C19 MAJOR 3: UPDATE carries school_id predicate too,
      // not just the FOR UPDATE lock above. Mirrors the wider Phase 2
      // pattern of carrying school_id through every tenant write
      // statement defensively.
      params.push(id);
      params.push(tenant.schoolId);
      try {
        await tx.$executeRawUnsafe(
          'UPDATE msg_templates SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            (params.length - 1) +
            '::uuid AND school_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'A template named "' +
              (input.name ?? '<unchanged>') +
              '" already exists in this school.',
          );
        }
        throw err;
      }
      const rows = await tx.$queryRawUnsafe<TemplateRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, name, category, ' +
          'subject_template, body_template, variables, allowed_roles, is_active, ' +
          'created_by::text AS created_by, created_at::text AS created_at, ' +
          'updated_at::text AS updated_at ' +
          'FROM msg_templates WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
      return rowToDto(rows[0]!);
    });
  }

  /**
   * Render keystone — validates required variables and interpolates
   * the template. Returns 400 with the offending variable names when
   * any required variable is missing AND has no default value.
   */
  async render(
    id: string,
    input: RenderTemplateDto,
    actor: ResolvedActor,
  ): Promise<RenderedTemplateDto> {
    const template = await this.getById(id, actor);
    const values: Record<string, string> = {};
    const missing: string[] = [];
    const supplied = input.values ?? {};
    for (const v of template.variables) {
      const provided = supplied[v.name];
      if (provided !== undefined && provided !== null && String(provided).length > 0) {
        values[v.name] = String(provided);
      } else if (v.defaultValue !== undefined) {
        values[v.name] = v.defaultValue;
      } else if (v.required) {
        missing.push(v.name);
      }
    }
    if (missing.length > 0) {
      throw new BadRequestException('Missing required template variables: ' + missing.join(', '));
    }
    // Permit extra values that aren't declared as variables — they
    // simply have no placeholder match. Required slot gating is the
    // only validation; loose values are ignored.
    const subject = template.subjectTemplate ? interpolate(template.subjectTemplate, values) : null;
    const body = interpolate(template.bodyTemplate, values);
    return { templateId: template.id, subject, body };
  }

  /**
   * Render + log the usage event. Returns the rendered output. The
   * usage row carries (template_id, used_by, used_at, broadcast_id,
   * thread_id, rendered_subject) so the analytics endpoint can
   * surface per-template counts + last-used.
   */
  async use(id: string, input: UseTemplateDto, actor: ResolvedActor): Promise<RenderedTemplateDto> {
    const rendered = await this.render(id, { values: input.values ?? {} }, actor);
    const usageId = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      await client.$executeRawUnsafe(
        'INSERT INTO msg_template_usage_log ' +
          '(id, template_id, used_by, broadcast_id, thread_id, rendered_subject) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
        usageId,
        id,
        actor.accountId,
        input.broadcastId ? input.broadcastId : null,
        input.threadId ? input.threadId : null,
        rendered.subject,
      );
    });
    return rendered;
  }

  async getAnalytics(id: string, actor: ResolvedActor): Promise<TemplateAnalyticsDto> {
    // Guard: caller must be able to read the template.
    await this.getById(id, actor);
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<
        Array<{ usage_count: number; last_used_at: string | null }>
      >(
        'SELECT COUNT(*)::int AS usage_count, MAX(used_at)::text AS last_used_at ' +
          'FROM msg_template_usage_log WHERE template_id = $1::uuid',
        id,
      );
      const row = rows[0]!;
      return {
        templateId: id,
        usageCount: Number(row.usage_count ?? 0),
        lastUsedAt: row.last_used_at,
      };
    });
  }

  async listUsage(id: string, actor: ResolvedActor): Promise<TemplateUsageDto[]> {
    await this.getById(id, actor);
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<UsageRow[]>(
        'SELECT id::text AS id, template_id::text AS template_id, used_by::text AS used_by, ' +
          'used_at::text AS used_at, broadcast_id::text AS broadcast_id, ' +
          'thread_id::text AS thread_id, rendered_subject ' +
          'FROM msg_template_usage_log WHERE template_id = $1::uuid ' +
          'ORDER BY used_at DESC LIMIT 100',
        id,
      );
      return rows.map(usageToDto);
    });
  }

  private variableToJson(v: TemplateVariableDto): Record<string, unknown> {
    const json: Record<string, unknown> = { name: v.name };
    if (v.description !== undefined) json.description = v.description;
    if (v.required !== undefined) json.required = v.required;
    if (v.defaultValue !== undefined) json.default_value = v.defaultValue;
    return json;
  }

  private roleTokensFor(actor: ResolvedActor): string[] {
    // Map ResolvedActor persona to the canonical IAM role tokens used
    // by allowed_roles. Mirrors the cycle-3 conventions:
    //   STAFF      -> TEACHER + STAFF + (SCHOOL_ADMIN when isSchoolAdmin)
    //   GUARDIAN   -> PARENT
    //   STUDENT    -> STUDENT
    const tokens = new Set<string>();
    if (actor.isSchoolAdmin) tokens.add('SCHOOL_ADMIN');
    if (actor.personType === 'STAFF') {
      tokens.add('TEACHER');
      tokens.add('STAFF');
    } else if (actor.personType === 'GUARDIAN') {
      tokens.add('PARENT');
    } else if (actor.personType === 'STUDENT') {
      tokens.add('STUDENT');
    }
    return Array.from(tokens);
  }
}
