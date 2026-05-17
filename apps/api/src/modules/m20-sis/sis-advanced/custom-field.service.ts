import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CUSTOM_FIELD_ENTITY_TYPES,
  CUSTOM_FIELD_TYPES,
  type CreateCustomFieldDefinitionDto,
  type CustomFieldDefinitionDto,
  type CustomFieldEntityType,
  type CustomFieldType,
  type CustomFieldValueDto,
  type UpdateCustomFieldDefinitionDto,
  type UpsertCustomFieldValuesDto,
} from './dto/sis-advanced.dto';

interface DefinitionRow {
  id: string;
  school_id: string;
  entity_type: string;
  field_name: string;
  field_label: string;
  field_type: string;
  enum_options: string[] | null;
  is_required: boolean;
  is_visible_to_parent: boolean;
  sort_order: number;
  is_active: boolean;
}

interface ValueRow {
  id: string;
  definition_id: string;
  entity_id: string;
  field_name: string;
  field_label: string;
  field_type: string;
  value_text: string | null;
  value_number: number | string | null;
  value_date: string | null;
  value_boolean: boolean | null;
  value_enum: string | null;
  value_multi: string[] | null;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  const meta = (err as { meta?: { code?: string } }).meta;
  if (code === 'P2002') return true;
  if (code === 'P2010' && meta?.code === '23505') return true;
  return false;
}

@Injectable()
export class CustomFieldService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private definitionRowToDto(r: DefinitionRow): CustomFieldDefinitionDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      entityType: r.entity_type as CustomFieldEntityType,
      fieldName: r.field_name,
      fieldLabel: r.field_label,
      fieldType: r.field_type as CustomFieldType,
      enumOptions: r.enum_options,
      isRequired: r.is_required,
      isVisibleToParent: r.is_visible_to_parent,
      sortOrder: r.sort_order,
      isActive: r.is_active,
    };
  }

  private async isAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-002:admin',
    ]);
  }

  private assertEntityType(entityType: string): void {
    if (!CUSTOM_FIELD_ENTITY_TYPES.includes(entityType as CustomFieldEntityType)) {
      throw new BadRequestException(
        'entityType must be one of ' + CUSTOM_FIELD_ENTITY_TYPES.join(', '),
      );
    }
  }

  private assertFieldType(fieldType: string): void {
    if (!CUSTOM_FIELD_TYPES.includes(fieldType as CustomFieldType)) {
      throw new BadRequestException('fieldType must be one of ' + CUSTOM_FIELD_TYPES.join(', '));
    }
  }

  async listDefinitions(
    entityType: string,
    args: { includeInactive?: boolean },
  ): Promise<CustomFieldDefinitionDto[]> {
    this.assertEntityType(entityType);
    const tenant = getCurrentTenant();
    const includeInactive = !!args.includeInactive;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<DefinitionRow[]>(
        'SELECT id::text, school_id::text, entity_type, field_name, field_label, ' +
          'field_type, enum_options, is_required, is_visible_to_parent, sort_order, is_active ' +
          'FROM sis_custom_field_definitions WHERE school_id = $1::uuid AND entity_type = $2 ' +
          'AND ($3::boolean OR is_active = true) ORDER BY sort_order ASC, field_label ASC',
        tenant.schoolId,
        entityType,
        includeInactive,
      ),
    );
    return rows.map((r) => this.definitionRowToDto(r));
  }

  async createDefinition(
    dto: CreateCustomFieldDefinitionDto,
    actor: ResolvedActor,
  ): Promise<CustomFieldDefinitionDto> {
    if (!(await this.isAdmin(actor))) {
      throw new ForbiddenException('Only admins can define custom fields.');
    }
    this.assertEntityType(dto.entityType);
    this.assertFieldType(dto.fieldType);

    // ENUM + MULTI_SELECT require enum_options
    if (
      (dto.fieldType === 'ENUM' || dto.fieldType === 'MULTI_SELECT') &&
      (!dto.enumOptions || dto.enumOptions.length === 0)
    ) {
      throw new BadRequestException(
        'ENUM and MULTI_SELECT fields require a non-empty enumOptions array.',
      );
    }

    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$executeRawUnsafe(
          'INSERT INTO sis_custom_field_definitions (id, school_id, entity_type, field_name, ' +
            'field_label, field_type, enum_options, is_required, is_visible_to_parent, sort_order) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[], $8, $9, $10)',
          id,
          tenant.schoolId,
          dto.entityType,
          dto.fieldName,
          dto.fieldLabel,
          dto.fieldType,
          dto.enumOptions ?? null,
          dto.isRequired ?? false,
          dto.isVisibleToParent ?? false,
          dto.sortOrder ?? 0,
        ),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A custom field with name ' +
            dto.fieldName +
            ' already exists for entity ' +
            dto.entityType,
        );
      }
      throw err;
    }

    return this.getDefinitionByIdOrFail(id);
  }

  async patchDefinition(
    id: string,
    dto: UpdateCustomFieldDefinitionDto,
    actor: ResolvedActor,
  ): Promise<CustomFieldDefinitionDto> {
    if (!(await this.isAdmin(actor))) {
      throw new ForbiddenException('Only admins can modify custom field definitions.');
    }
    const existing = await this.getDefinitionByIdOrFail(id);

    if (
      (existing.fieldType === 'ENUM' || existing.fieldType === 'MULTI_SELECT') &&
      dto.enumOptions !== undefined &&
      (!dto.enumOptions || dto.enumOptions.length === 0)
    ) {
      throw new BadRequestException(
        'ENUM and MULTI_SELECT fields require a non-empty enumOptions array.',
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let n = 1;
    if (dto.fieldLabel !== undefined) {
      sets.push('field_label = $' + n);
      params.push(dto.fieldLabel);
      n += 1;
    }
    if (dto.enumOptions !== undefined) {
      sets.push('enum_options = $' + n + '::text[]');
      params.push(dto.enumOptions);
      n += 1;
    }
    if (dto.isRequired !== undefined) {
      sets.push('is_required = $' + n);
      params.push(dto.isRequired);
      n += 1;
    }
    if (dto.isVisibleToParent !== undefined) {
      sets.push('is_visible_to_parent = $' + n);
      params.push(dto.isVisibleToParent);
      n += 1;
    }
    if (dto.sortOrder !== undefined) {
      sets.push('sort_order = $' + n);
      params.push(dto.sortOrder);
      n += 1;
    }
    if (dto.isActive !== undefined) {
      sets.push('is_active = $' + n);
      params.push(dto.isActive);
      n += 1;
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      // P2-H1 Step 1: school-scope the UPDATE as defence-in-depth.
      const tenant = getCurrentTenant();
      params.push(tenant.schoolId);
      await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$executeRawUnsafe(
          'UPDATE sis_custom_field_definitions SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            n +
            '::uuid AND school_id = $' +
            (n + 1) +
            '::uuid',
          ...params,
        ),
      );
    }
    return this.getDefinitionByIdOrFail(id);
  }

  async getDefinitionByIdOrFail(id: string): Promise<CustomFieldDefinitionDto> {
    // P2-H1 Step 1: school-scope so foreign-school definition ids collapse to 404.
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<DefinitionRow[]>(
        'SELECT id::text, school_id::text, entity_type, field_name, field_label, ' +
          'field_type, enum_options, is_required, is_visible_to_parent, sort_order, is_active ' +
          'FROM sis_custom_field_definitions WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Custom field definition not found');
    return this.definitionRowToDto(rows[0]!);
  }

  /**
   * Per-(entity) values. Parents only see is_visible_to_parent=true rows;
   * everyone with stu-002:read sees the full list otherwise.
   */
  async listValuesForEntity(
    entityType: string,
    entityId: string,
    actor: ResolvedActor,
  ): Promise<CustomFieldValueDto[]> {
    this.assertEntityType(entityType);
    const tenant = getCurrentTenant();
    const isParent = actor.personType === 'GUARDIAN' && !actor.isSchoolAdmin;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<ValueRow[]>(
        'SELECT v.id::text, v.definition_id::text, v.entity_id::text, ' +
          'd.field_name, d.field_label, d.field_type, ' +
          'v.value_text, v.value_number::text AS value_number, ' +
          'v.value_date::text AS value_date, v.value_boolean, ' +
          'v.value_enum, v.value_multi ' +
          'FROM sis_custom_field_values v ' +
          'JOIN sis_custom_field_definitions d ON d.id = v.definition_id ' +
          'WHERE d.school_id = $1::uuid AND d.entity_type = $2 AND v.entity_id = $3::uuid ' +
          'AND d.is_active = true AND ($4::boolean = false OR d.is_visible_to_parent = true) ' +
          'ORDER BY d.sort_order ASC, d.field_label ASC',
        tenant.schoolId,
        entityType,
        entityId,
        isParent,
      ),
    );
    return rows.map((r) => {
      let value: string | number | boolean | string[] | null = null;
      if (r.field_type === 'TEXT') value = r.value_text;
      else if (r.field_type === 'NUMBER')
        value = r.value_number !== null ? Number(r.value_number) : null;
      else if (r.field_type === 'DATE') value = r.value_date;
      else if (r.field_type === 'BOOLEAN') value = r.value_boolean;
      else if (r.field_type === 'ENUM') value = r.value_enum;
      else if (r.field_type === 'MULTI_SELECT') value = r.value_multi;

      return {
        id: r.id,
        definitionId: r.definition_id,
        fieldName: r.field_name,
        fieldLabel: r.field_label,
        fieldType: r.field_type as CustomFieldType,
        entityId: r.entity_id,
        value,
      };
    });
  }

  /**
   * Bulk upsert values for one entity. Validates each supplied value's
   * type matches the definition.field_type. ENUM values must be one of
   * the definition.enum_options. MULTI_SELECT values must all be in the
   * options array.
   */
  async upsertValues(
    dto: UpsertCustomFieldValuesDto,
    actor: ResolvedActor,
  ): Promise<CustomFieldValueDto[]> {
    if (!(await this.isAdmin(actor))) {
      // Allow STAFF + actor.employeeId to upsert too — admins drive most
      // changes but staff can update class-level custom values etc.
      const tenant = getCurrentTenant();
      const hasWrite = await this.permissions.hasAnyPermissionInTenant(
        actor.accountId,
        tenant.schoolId,
        ['stu-002:write'],
      );
      if (!hasWrite || actor.personType !== 'STAFF') {
        throw new ForbiddenException('Only staff or admins can upsert custom field values.');
      }
    }
    this.assertEntityType(dto.entityType);

    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // P2-H5 DEFECT 1f fix: validate the target entity belongs to the
      // calling school BEFORE any UPSERT. Pre-fix only the definition was
      // school-scoped, so a current-school definition could attach values to
      // a foreign-school entityId (the sis_custom_field_values table has no
      // school_id column — the only guard is the entity's parent table).
      const entityTable: Record<string, string> = {
        STUDENT: 'sis_students',
        STAFF: 'hr_employees',
        GUARDIAN: 'sis_guardians',
        CLASS: 'sis_classes',
      };
      const targetTable = entityTable[dto.entityType];
      if (!targetTable) {
        throw new BadRequestException('Unsupported entityType ' + dto.entityType);
      }
      const entityRows = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM ' +
          targetTable +
          ' WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        dto.entityId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (entityRows.length === 0) {
        throw new BadRequestException(
          'entityId does not match a ' + dto.entityType + ' in this school',
        );
      }

      for (const v of dto.values) {
        const defRows = await tx.$queryRawUnsafe<DefinitionRow[]>(
          'SELECT id::text, school_id::text, entity_type, field_name, field_label, field_type, ' +
            'enum_options, is_required, is_visible_to_parent, sort_order, is_active ' +
            'FROM sis_custom_field_definitions WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          v.definitionId,
          tenant.schoolId,
        );
        if (defRows.length === 0) {
          throw new BadRequestException(
            'Custom field definition ' + v.definitionId + ' not found in this school',
          );
        }
        const def = defRows[0]!;
        if (def.entity_type !== dto.entityType) {
          throw new BadRequestException(
            'Definition ' +
              def.field_name +
              ' is for entity ' +
              def.entity_type +
              ', not ' +
              dto.entityType,
          );
        }
        if (!def.is_active) {
          throw new BadRequestException(
            'Custom field definition ' + def.field_name + ' is inactive',
          );
        }

        // Validate value type matches field_type.
        let valueText: string | null = null;
        let valueNumber: number | null = null;
        let valueDate: string | null = null;
        let valueBoolean: boolean | null = null;
        let valueEnum: string | null = null;
        let valueMulti: string[] | null = null;

        const raw = v.value ?? null;
        if (raw === null) {
          // null is allowed — clears the value
        } else if (def.field_type === 'TEXT') {
          if (typeof raw !== 'string') {
            throw new BadRequestException(
              'Field ' + def.field_name + ' expects TEXT; got ' + typeof raw,
            );
          }
          valueText = raw;
        } else if (def.field_type === 'NUMBER') {
          if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            throw new BadRequestException(
              'Field ' + def.field_name + ' expects NUMBER; got ' + typeof raw,
            );
          }
          valueNumber = raw;
        } else if (def.field_type === 'DATE') {
          if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
            throw new BadRequestException(
              'Field ' + def.field_name + ' expects DATE in YYYY-MM-DD format',
            );
          }
          valueDate = raw;
        } else if (def.field_type === 'BOOLEAN') {
          if (typeof raw !== 'boolean') {
            throw new BadRequestException(
              'Field ' + def.field_name + ' expects BOOLEAN; got ' + typeof raw,
            );
          }
          valueBoolean = raw;
        } else if (def.field_type === 'ENUM') {
          if (typeof raw !== 'string') {
            throw new BadRequestException(
              'Field ' + def.field_name + ' expects ENUM string; got ' + typeof raw,
            );
          }
          if (!def.enum_options?.includes(raw)) {
            throw new BadRequestException(
              'Value ' + raw + ' is not one of the allowed enum_options for ' + def.field_name,
            );
          }
          valueEnum = raw;
        } else if (def.field_type === 'MULTI_SELECT') {
          if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
            throw new BadRequestException(
              'Field ' + def.field_name + ' expects MULTI_SELECT array of strings',
            );
          }
          for (const item of raw) {
            if (!def.enum_options?.includes(item)) {
              throw new BadRequestException(
                'Value ' + item + ' is not in the allowed enum_options for ' + def.field_name,
              );
            }
          }
          valueMulti = raw as string[];
        }

        await tx.$executeRawUnsafe(
          'INSERT INTO sis_custom_field_values (id, definition_id, entity_id, value_text, ' +
            'value_number, value_date, value_boolean, value_enum, value_multi) VALUES ' +
            '($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::date, $7::boolean, $8, $9::text[]) ' +
            'ON CONFLICT (definition_id, entity_id) DO UPDATE SET ' +
            'value_text = EXCLUDED.value_text, value_number = EXCLUDED.value_number, ' +
            'value_date = EXCLUDED.value_date, value_boolean = EXCLUDED.value_boolean, ' +
            'value_enum = EXCLUDED.value_enum, value_multi = EXCLUDED.value_multi, ' +
            'updated_at = now()',
          generateId(),
          v.definitionId,
          dto.entityId,
          valueText,
          valueNumber,
          valueDate,
          valueBoolean,
          valueEnum,
          valueMulti,
        );
      }
    });
    return this.listValuesForEntity(dto.entityType, dto.entityId, actor);
  }
}
