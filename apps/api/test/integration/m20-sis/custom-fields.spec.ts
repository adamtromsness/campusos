import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { CustomFieldService } from '@modules/m20-sis/custom-fields/custom-field.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, teacherActor, parentActor, TEST_PARENT_PERSON_ID } from '../helpers/actor';
import { seedStudent, cleanupSeededIds } from './sis-helpers';

/**
 * Wave 4 — m20-sis CustomFieldService DB-backed integration.
 *
 * Strategy doc Wave 4 spotlight:
 *   "Custom field upsertValues validates target entity school (Codex
 *    defect area)" — exercised via the cross-school entityId test below.
 *
 * Contracts:
 *   - Definition CRUD respects (school_id, entity_type, field_name) UNIQUE
 *   - Definition lookups + updates are school-scoped (P2-H1)
 *   - ENUM/MULTI_SELECT requires non-empty enum_options at create + patch
 *   - upsertValues validates entityId belongs to current school (P2-H5 1f)
 *   - upsertValues validates each value matches field_type (TEXT, NUMBER,
 *     DATE, BOOLEAN, ENUM, MULTI_SELECT) with type-narrow errors
 *   - Inactive definition cannot accept values
 *   - listValuesForEntity hides non-parent-visible defs from GUARDIAN
 *   - Cross-school: definition in School A invisible in School B context
 */
describe('integration:m20-sis/custom-fields', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let service: CustomFieldService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    service = new CustomFieldService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_custom_field_values`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_custom_field_definitions`,
    );
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      personIds: personIds.splice(0),
    });
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  describe('definition CRUD', () => {
    it('admin creates TEXT definition + lists it', async () => {
      const def = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'favourite_subject',
            fieldLabel: 'Favourite Subject',
            fieldType: 'TEXT',
            isVisibleToParent: true,
          } as any,
          adminActor(),
        ),
      );
      expect(def.fieldName).toBe('favourite_subject');
      expect(def.schoolId).toBe(TEST_SCHOOL_ID);

      const list = await withTestTenant(async () =>
        service.listDefinitions('STUDENT', {}),
      );
      expect(list.map((r) => r.id)).toContain(def.id);
    });

    it('admin creates ENUM + MULTI_SELECT definitions with options', async () => {
      const enumDef = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'house',
            fieldLabel: 'House',
            fieldType: 'ENUM',
            enumOptions: ['Red', 'Blue', 'Green'],
          } as any,
          adminActor(),
        ),
      );
      expect(enumDef.enumOptions).toEqual(['Red', 'Blue', 'Green']);
      const multi = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'clubs',
            fieldLabel: 'Clubs',
            fieldType: 'MULTI_SELECT',
            enumOptions: ['Chess', 'Robotics', 'Choir'],
          } as any,
          adminActor(),
        ),
      );
      expect(multi.fieldType).toBe('MULTI_SELECT');
    });

    it('ENUM without enumOptions → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.createDefinition(
            {
              entityType: 'STUDENT',
              fieldName: 'broken',
              fieldLabel: 'Broken',
              fieldType: 'ENUM',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invalid entityType → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.createDefinition(
            {
              entityType: 'NOPE',
              fieldName: 'x',
              fieldLabel: 'x',
              fieldType: 'TEXT',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invalid fieldType → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.createDefinition(
            {
              entityType: 'STUDENT',
              fieldName: 'x',
              fieldLabel: 'x',
              fieldType: 'WRONG',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate (school, entity, field_name) → ConflictException', async () => {
      await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'duplicate',
            fieldLabel: 'Dup',
            fieldType: 'TEXT',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.createDefinition(
            {
              entityType: 'STUDENT',
              fieldName: 'duplicate',
              fieldLabel: 'Dup2',
              fieldType: 'TEXT',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-admin createDefinition → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.createDefinition(
            {
              entityType: 'STUDENT',
              fieldName: 'denied',
              fieldLabel: 'Denied',
              fieldType: 'TEXT',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patchDefinition updates label + isRequired + sortOrder', async () => {
      const def = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'STUDENT', fieldName: 'pen', fieldLabel: 'Pen', fieldType: 'TEXT' } as any,
          adminActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        service.patchDefinition(
          def.id,
          { fieldLabel: 'New Label', isRequired: true, sortOrder: 5, isVisibleToParent: true, isActive: false } as any,
          adminActor(),
        ),
      );
      expect(patched.fieldLabel).toBe('New Label');
      expect(patched.isRequired).toBe(true);
      expect(patched.sortOrder).toBe(5);
      expect(patched.isActive).toBe(false);
    });

    it('patchDefinition on ENUM with empty enumOptions → BadRequestException', async () => {
      const def = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'pen2',
            fieldLabel: 'Pen2',
            fieldType: 'ENUM',
            enumOptions: ['X', 'Y'],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.patchDefinition(def.id, { enumOptions: [] } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin patchDefinition → ForbiddenException', async () => {
      const def = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'STUDENT', fieldName: 'pf', fieldLabel: 'PF', fieldType: 'TEXT' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.patchDefinition(def.id, { fieldLabel: 'attempt' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school definition id → NotFoundException', async () => {
      const defInB = await withTestTenantB(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'b_def',
            fieldLabel: 'B Def',
            fieldType: 'TEXT',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.getDefinitionByIdOrFail(defInB.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listDefinitions excludes inactive by default and includes when requested', async () => {
      const active = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'STUDENT', fieldName: 'on', fieldLabel: 'On', fieldType: 'TEXT' } as any,
          adminActor(),
        ),
      );
      const inactive = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'STUDENT', fieldName: 'off', fieldLabel: 'Off', fieldType: 'TEXT' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.patchDefinition(inactive.id, { isActive: false } as any, adminActor()),
      );
      const defaultList = await withTestTenant(async () =>
        service.listDefinitions('STUDENT', {}),
      );
      expect(defaultList.map((r) => r.id)).toContain(active.id);
      expect(defaultList.map((r) => r.id)).not.toContain(inactive.id);

      const withInactive = await withTestTenant(async () =>
        service.listDefinitions('STUDENT', { includeInactive: true }),
      );
      expect(withInactive.map((r) => r.id)).toContain(inactive.id);
    });
  });

  describe('upsertValues', () => {
    it('admin upserts TEXT + NUMBER values then re-reads them', async () => {
      const s = await trackedStudent({ firstName: 'CF', lastName: 'Val' });
      const textDef = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 't1',
            fieldLabel: 'T1',
            fieldType: 'TEXT',
          } as any,
          adminActor(),
        ),
      );
      const numDef = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'n1',
            fieldLabel: 'N1',
            fieldType: 'NUMBER',
          } as any,
          adminActor(),
        ),
      );
      const result = await withTestTenant(async () =>
        service.upsertValues(
          {
            entityType: 'STUDENT',
            entityId: s.studentId,
            values: [
              { definitionId: textDef.id, value: 'hello' },
              { definitionId: numDef.id, value: 42 },
            ],
          } as any,
          adminActor(),
        ),
      );
      const byField = new Map(result.map((r) => [r.fieldName, r.value]));
      expect(byField.get('t1')).toBe('hello');
      expect(byField.get('n1')).toBe(42);

      // Re-upsert updates the row (ON CONFLICT path)
      const updated = await withTestTenant(async () =>
        service.upsertValues(
          {
            entityType: 'STUDENT',
            entityId: s.studentId,
            values: [{ definitionId: textDef.id, value: 'world' }],
          } as any,
          adminActor(),
        ),
      );
      expect(new Map(updated.map((r) => [r.fieldName, r.value])).get('t1')).toBe('world');
    });

    it('cross-school entityId → BadRequestException (Codex defect FIX)', async () => {
      const def = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'STUDENT', fieldName: 'cs', fieldLabel: 'CS', fieldType: 'TEXT' } as any,
          adminActor(),
        ),
      );
      // School B student — definition lives in School A, entity is in School B
      const bStudent = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          service.upsertValues(
            {
              entityType: 'STUDENT',
              entityId: bStudent.studentId,
              values: [{ definitionId: def.id, value: 'hi' }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown definitionId → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          service.upsertValues(
            {
              entityType: 'STUDENT',
              entityId: s.studentId,
              values: [
                { definitionId: '00000000-0000-0000-0000-000000000000', value: 'x' },
              ],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('type mismatch (NUMBER def, string value) → BadRequestException', async () => {
      const s = await trackedStudent();
      const def = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'STUDENT', fieldName: 'n2', fieldLabel: 'N2', fieldType: 'NUMBER' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.upsertValues(
            {
              entityType: 'STUDENT',
              entityId: s.studentId,
              values: [{ definitionId: def.id, value: 'not a number' }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('inactive definition → BadRequestException', async () => {
      const s = await trackedStudent();
      const def = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'STUDENT', fieldName: 'inact', fieldLabel: 'Inact', fieldType: 'TEXT' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.patchDefinition(def.id, { isActive: false } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          service.upsertValues(
            {
              entityType: 'STUDENT',
              entityId: s.studentId,
              values: [{ definitionId: def.id, value: 'x' }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('entity_type mismatch → BadRequestException', async () => {
      // GUARDIAN definition used against a STUDENT entity
      const s = await trackedStudent();
      const guardianDef = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'GUARDIAN', fieldName: 'g_def', fieldLabel: 'G', fieldType: 'TEXT' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.upsertValues(
            {
              entityType: 'STUDENT',
              entityId: s.studentId,
              values: [{ definitionId: guardianDef.id, value: 'x' }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ENUM value not in options → BadRequestException', async () => {
      const s = await trackedStudent();
      const def = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'e1',
            fieldLabel: 'E1',
            fieldType: 'ENUM',
            enumOptions: ['A', 'B'],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.upsertValues(
            {
              entityType: 'STUDENT',
              entityId: s.studentId,
              values: [{ definitionId: def.id, value: 'C' }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('MULTI_SELECT validates every member against options', async () => {
      const s = await trackedStudent();
      const def = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'm1',
            fieldLabel: 'M1',
            fieldType: 'MULTI_SELECT',
            enumOptions: ['X', 'Y', 'Z'],
          } as any,
          adminActor(),
        ),
      );
      // Valid
      const ok = await withTestTenant(async () =>
        service.upsertValues(
          {
            entityType: 'STUDENT',
            entityId: s.studentId,
            values: [{ definitionId: def.id, value: ['X', 'Y'] }],
          } as any,
          adminActor(),
        ),
      );
      expect(ok[0]!.value).toEqual(['X', 'Y']);

      // Bad member
      await expect(
        withTestTenant(async () =>
          service.upsertValues(
            {
              entityType: 'STUDENT',
              entityId: s.studentId,
              values: [{ definitionId: def.id, value: ['X', 'Q'] }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('DATE value enforces YYYY-MM-DD format', async () => {
      const s = await trackedStudent();
      const def = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'STUDENT', fieldName: 'd1', fieldLabel: 'D1', fieldType: 'DATE' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.upsertValues(
            {
              entityType: 'STUDENT',
              entityId: s.studentId,
              values: [{ definitionId: def.id, value: '2026/01/01' }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const ok = await withTestTenant(async () =>
        service.upsertValues(
          {
            entityType: 'STUDENT',
            entityId: s.studentId,
            values: [{ definitionId: def.id, value: '2026-01-15' }],
          } as any,
          adminActor(),
        ),
      );
      expect(ok[0]!.value).toBe('2026-01-15');
    });

    it('null value clears the row', async () => {
      const s = await trackedStudent();
      const def = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'STUDENT', fieldName: 'clear', fieldLabel: 'C', fieldType: 'TEXT' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.upsertValues(
          {
            entityType: 'STUDENT',
            entityId: s.studentId,
            values: [{ definitionId: def.id, value: 'something' }],
          } as any,
          adminActor(),
        ),
      );
      const cleared = await withTestTenant(async () =>
        service.upsertValues(
          {
            entityType: 'STUDENT',
            entityId: s.studentId,
            values: [{ definitionId: def.id, value: null }],
          } as any,
          adminActor(),
        ),
      );
      expect(cleared[0]!.value).toBeNull();
    });

    it('non-admin non-staff (teacher) without stu-002:write → ForbiddenException', async () => {
      const s = await trackedStudent();
      const def = await withTestTenant(async () =>
        service.createDefinition(
          { entityType: 'STUDENT', fieldName: 'p', fieldLabel: 'P', fieldType: 'TEXT' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.upsertValues(
            {
              entityType: 'STUDENT',
              entityId: s.studentId,
              values: [{ definitionId: def.id, value: 'x' }],
            } as any,
            parentActor(),
          ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('listValuesForEntity', () => {
    it('admin sees all values', async () => {
      const s = await trackedStudent();
      const def = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'pub',
            fieldLabel: 'Pub',
            fieldType: 'TEXT',
            isVisibleToParent: true,
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.upsertValues(
          {
            entityType: 'STUDENT',
            entityId: s.studentId,
            values: [{ definitionId: def.id, value: 'hi' }],
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        service.listValuesForEntity('STUDENT', s.studentId, adminActor()),
      );
      expect(list).toHaveLength(1);
      expect(list[0]!.value).toBe('hi');
    });

    it('GUARDIAN only sees is_visible_to_parent=true values', async () => {
      const s = await trackedStudent();
      const publicDef = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'public_field',
            fieldLabel: 'Public',
            fieldType: 'TEXT',
            isVisibleToParent: true,
          } as any,
          adminActor(),
        ),
      );
      const privateDef = await withTestTenant(async () =>
        service.createDefinition(
          {
            entityType: 'STUDENT',
            fieldName: 'private_field',
            fieldLabel: 'Private',
            fieldType: 'TEXT',
            isVisibleToParent: false,
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.upsertValues(
          {
            entityType: 'STUDENT',
            entityId: s.studentId,
            values: [
              { definitionId: publicDef.id, value: 'visible' },
              { definitionId: privateDef.id, value: 'hidden' },
            ],
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(
        async () => service.listValuesForEntity('STUDENT', s.studentId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      const fields = list.map((r) => r.fieldName);
      expect(fields).toContain('public_field');
      expect(fields).not.toContain('private_field');
    });
  });
});
