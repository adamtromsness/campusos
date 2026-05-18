import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { SurveyTemplateService } from '@modules/m27-student-services/wellbeing/survey-template.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  studentActor,
  parentActor,
  teacherActor,
  TEST_OFFICER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

describe('integration:m27-student-services/survey-template', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let service: SurveyTemplateService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    service = new SurveyTemplateService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_questions WHERE template_id IN
         (SELECT id FROM ${TEST_SCHEMA}.svc_wellbeing_survey_templates WHERE name LIKE 'TST-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_survey_templates WHERE name LIKE 'TST-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantOfficer(codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      name: 'TST-Tpl-' + Math.random().toString(36).slice(2, 8),
      description: 'Test survey',
      frequencyRecommendation: 'WEEKLY' as const,
      questions: [
        {
          questionText: 'How safe do you feel?',
          questionType: 'SCALE_1_5' as const,
          domain: 'SAFETY' as const,
          sortOrder: 0,
        },
        {
          questionText: 'How are you sleeping?',
          questionType: 'SCALE_1_5' as const,
          domain: 'PHYSICAL' as const,
          sortOrder: 1,
        },
      ],
      ...overrides,
    };
  }

  describe('create', () => {
    it('admin creates template + questions atomically', async () => {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      expect(t.isActive).toBe(true);
      expect(t.frequencyRecommendation).toBe('WEEKLY');
      expect(t.questions).toHaveLength(2);
    });

    it('officer with cou-004:write can create', async () => {
      await grantOfficer(['cou-004:write']);
      const t = await withTestTenant(async () => service.create(baseInput(), officerActor()));
      expect(t.id).toBeTruthy();
    });

    it('non-counsellor → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.create(baseInput(), officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(baseInput(), teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(baseInput(), studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(baseInput(), parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate name in same school → BadRequest', async () => {
      const input = baseInput();
      await withTestTenant(async () => service.create(input, adminActor()));
      await expect(
        withTestTenant(async () => service.create(input, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('list / getById / listQuestions', () => {
    it('list (default) returns active templates only', async () => {
      const a = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      const b = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      await withTestTenant(async () => service.patch(b.id, { isActive: false }, adminActor()));
      const list = await withTestTenant(async () => service.list());
      expect(list.find((t) => t.id === a.id)).toBeDefined();
      expect(list.find((t) => t.id === b.id)).toBeUndefined();
    });

    it('list includeInactive returns both', async () => {
      const a = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      await withTestTenant(async () => service.patch(a.id, { isActive: false }, adminActor()));
      const all = await withTestTenant(async () => service.list(true));
      expect(all.find((t) => t.id === a.id)).toBeDefined();
    });

    it('getById returns template + questions', async () => {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      const detail = await withTestTenant(async () => service.getById(t.id));
      expect(detail.questions!.length).toBe(2);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById cross-school → NotFound', async () => {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      await expect(
        withTestTenantB(async () => service.getById(t.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listQuestions returns sorted by sort_order', async () => {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      const qs = await withTestTenant(async () => service.listQuestions(t.id));
      expect(qs.length).toBe(2);
      expect(qs[0]!.sortOrder).toBe(0);
      expect(qs[1]!.sortOrder).toBe(1);
    });
  });

  describe('patch', () => {
    it('admin patches fields', async () => {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      const updated = await withTestTenant(async () =>
        service.patch(
          t.id,
          {
            name: 'TST-Renamed-' + Math.random().toString(36).slice(2, 6),
            description: 'Updated',
            frequencyRecommendation: 'MONTHLY',
            isActive: false,
          },
          adminActor(),
        ),
      );
      expect(updated.frequencyRecommendation).toBe('MONTHLY');
      expect(updated.isActive).toBe(false);
    });

    it('empty patch returns existing', async () => {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      const r = await withTestTenant(async () => service.patch(t.id, {}, adminActor()));
      expect(r.id).toBe(t.id);
    });

    it('rename to duplicate → BadRequest', async () => {
      const a = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      const b = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      await expect(
        withTestTenant(async () =>
          service.patch(b.id, { name: a.name }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing template → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.patch(generateId(), { name: 'TST-Missing' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-counsellor → Forbidden', async () => {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      await expect(
        withTestTenant(async () => service.patch(t.id, { name: 'x' }, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('addQuestion', () => {
    async function seedTemplate(): Promise<string> {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      return t.id;
    }

    it('appends a new question', async () => {
      const templateId = await seedTemplate();
      const q = await withTestTenant(async () =>
        service.addQuestion(
          templateId,
          {
            questionText: 'Are you feeling supported?',
            questionType: 'YES_NO',
            domain: 'EMOTIONAL',
            sortOrder: 2,
          },
          adminActor(),
        ),
      );
      expect(q.sortOrder).toBe(2);
      expect(q.domain).toBe('EMOTIONAL');
    });

    it('missing template → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.addQuestion(
            generateId(),
            {
              questionText: 'x',
              questionType: 'YES_NO',
              domain: 'SAFETY',
              sortOrder: 0,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-counsellor → Forbidden', async () => {
      const templateId = await seedTemplate();
      await expect(
        withTestTenant(async () =>
          service.addQuestion(
            templateId,
            {
              questionText: 'x',
              questionType: 'YES_NO',
              domain: 'SAFETY',
              sortOrder: 0,
            },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('patchQuestion + deleteQuestion', () => {
    async function seedTemplateAndQuestion(): Promise<{ templateId: string; questionId: string }> {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      const qs = await withTestTenant(async () => service.listQuestions(t.id));
      return { templateId: t.id, questionId: qs[0]!.id };
    }

    it('patchQuestion updates text + type + domain + sortOrder', async () => {
      const { questionId } = await seedTemplateAndQuestion();
      const updated = await withTestTenant(async () =>
        service.patchQuestion(
          questionId,
          {
            questionText: 'Updated text',
            questionType: 'EMOJI_SCALE',
            domain: 'ACADEMIC',
            sortOrder: 99,
          },
          adminActor(),
        ),
      );
      expect(updated.questionText).toBe('Updated text');
      expect(updated.questionType).toBe('EMOJI_SCALE');
      expect(updated.domain).toBe('ACADEMIC');
      expect(updated.sortOrder).toBe(99);
    });

    it('patchQuestion empty no-op returns existing', async () => {
      const { questionId } = await seedTemplateAndQuestion();
      const updated = await withTestTenant(async () =>
        service.patchQuestion(questionId, {}, adminActor()),
      );
      expect(updated.id).toBe(questionId);
    });

    it('patchQuestion missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.patchQuestion(generateId(), { questionText: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patchQuestion as non-counsellor → Forbidden', async () => {
      const { questionId } = await seedTemplateAndQuestion();
      await expect(
        withTestTenant(async () =>
          service.patchQuestion(questionId, { questionText: 'x' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('deleteQuestion removes when no responses exist', async () => {
      const { questionId } = await seedTemplateAndQuestion();
      await withTestTenant(async () => service.deleteQuestion(questionId, adminActor()));
      await expect(
        withTestTenant(async () =>
          service.patchQuestion(questionId, { questionText: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deleteQuestion missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.deleteQuestion(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deleteQuestion as non-counsellor → Forbidden', async () => {
      const { questionId } = await seedTemplateAndQuestion();
      await expect(
        withTestTenant(async () => service.deleteQuestion(questionId, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('loadActiveOrFail', () => {
    it('returns template + questions for an active, populated template', async () => {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      const r = await withTestTenant(async () => service.loadActiveOrFail(t.id));
      expect(r.questions!.length).toBe(2);
    });

    it('inactive template → BadRequest', async () => {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      await withTestTenant(async () =>
        service.patch(t.id, { isActive: false }, adminActor()),
      );
      await expect(
        withTestTenant(async () => service.loadActiveOrFail(t.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('template with zero questions → BadRequest', async () => {
      const t = await withTestTenant(async () => service.create(baseInput(), adminActor()));
      const qs = await withTestTenant(async () => service.listQuestions(t.id));
      for (const q of qs) {
        await withTestTenant(async () => service.deleteQuestion(q.id, adminActor()));
      }
      await expect(
        withTestTenant(async () => service.loadActiveOrFail(t.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing template → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.loadActiveOrFail(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
