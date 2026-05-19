import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { AIMinutesService } from '@modules/m41-meetings/meetings/ai-minutes.service';
import { MeetingService } from '@modules/m41-meetings/meetings/meeting.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
} from '../helpers/actor';
import { TEST_MEETING_TYPE_ID, TEST_MEETING_TYPE_B_ID } from '../fixtures/meetings';

/**
 * Wave 5 — m41-meetings AIMinutesService.
 *
 * The AI Inference stub writes placeholder content stamped with
 * model_version='STUB_VERSION_0'. Status machine: PENDING → GENERATED
 * → APPROVED. Approve is irreversible. Approved minutes cannot be
 * regenerated.
 */
describe('integration:m41-meetings/ai-minutes', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let meetingService: MeetingService;
  let aiService: AIMinutesService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    meetingService = new MeetingService(tenantPrisma, outbox);
    aiService = new AIMinutesService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_ai_minutes`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_meetings WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'mtg.meeting.scheduled' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  async function createMeeting(typeId = TEST_MEETING_TYPE_ID): Promise<string> {
    const m = await withTestTenant(async () =>
      meetingService.create(
        {
          meetingTypeId: typeId,
          title: 'AI minutes test',
          scheduledAt: '2026-06-20T15:00:00Z',
          durationMinutes: 30,
        } as any,
        adminActor(),
      ),
    );
    return m.id;
  }

  async function createMeetingB(): Promise<string> {
    const m = await withTestTenantB(async () =>
      meetingService.create(
        {
          meetingTypeId: TEST_MEETING_TYPE_B_ID,
          title: 'B side',
          scheduledAt: '2026-06-20T15:00:00Z',
          durationMinutes: 30,
        } as any,
        adminActor(),
      ),
    );
    return m.id;
  }

  // ────────────────────────────────────────────────────────────────────
  // generate
  // ────────────────────────────────────────────────────────────────────
  describe('generate', () => {
    it('admin generates AI minutes → row inserted with status=GENERATED + stub content', async () => {
      const meetingId = await createMeeting();
      const dto = await withTestTenant(async () =>
        aiService.generate(
          meetingId,
          { rawTranscript: 'Some transcript words to summarise.' } as any,
          adminActor(),
        ),
      );
      expect(dto.status).toBe('GENERATED');
      expect(dto.modelVersion).toBe('STUB_VERSION_0');
      expect(dto.generatedAt).not.toBeNull();
      expect(dto.aiSummary).toMatch(/\[STUB\]/);
      expect(dto.aiActionItems.length).toBeGreaterThan(0);
      expect(dto.aiKeyDecisions.length).toBeGreaterThan(0);
    });

    it('generate with empty transcript → stub returns empty action items + zero-words summary', async () => {
      const meetingId = await createMeeting();
      const dto = await withTestTenant(async () =>
        aiService.generate(meetingId, { rawTranscript: '' } as any, adminActor()),
      );
      expect(dto.aiActionItems).toHaveLength(0);
      expect(dto.aiKeyDecisions).toHaveLength(0);
      expect(dto.aiSummary).toContain('No transcript provided');
    });

    it('duplicate generate for same meeting → BadRequestException (UNIQUE)', async () => {
      const meetingId = await createMeeting();
      await withTestTenant(async () =>
        aiService.generate(meetingId, { rawTranscript: 'a b c' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          aiService.generate(meetingId, { rawTranscript: 'a b c' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('STUDENT cannot generate → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      await expect(
        withTestTenant(async () =>
          aiService.generate(meetingId, { rawTranscript: 'x' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('GUARDIAN cannot generate → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      await expect(
        withTestTenant(async () =>
          aiService.generate(meetingId, { rawTranscript: 'x' } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: School A admin cannot generate against a School B meeting → ForbiddenException', async () => {
      const meetingId = await createMeetingB();
      await expect(
        withTestTenant(async () =>
          aiService.generate(meetingId, { rawTranscript: 'x' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getForMeeting + getById + loadOrFail
  // ────────────────────────────────────────────────────────────────────
  describe('reads', () => {
    it('getForMeeting returns null when no row exists', async () => {
      const meetingId = await createMeeting();
      const dto = await withTestTenant(async () =>
        aiService.getForMeeting(meetingId, adminActor()),
      );
      expect(dto).toBeNull();
    });

    it('getForMeeting returns row after generate', async () => {
      const meetingId = await createMeeting();
      const generated = await withTestTenant(async () =>
        aiService.generate(meetingId, { rawTranscript: 'hello' } as any, adminActor()),
      );
      const fetched = await withTestTenant(async () =>
        aiService.getForMeeting(meetingId, adminActor()),
      );
      expect(fetched?.id).toBe(generated.id);
    });

    it('getById returns row; missing or cross-school → NotFoundException', async () => {
      const meetingId = await createMeeting();
      const generated = await withTestTenant(async () =>
        aiService.generate(meetingId, { rawTranscript: 'words' } as any, adminActor()),
      );
      const fetched = await withTestTenant(async () =>
        aiService.getById(generated.id, adminActor()),
      );
      expect(fetched.id).toBe(generated.id);

      await expect(
        withTestTenant(async () =>
          aiService.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('STUDENT cannot read → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      await expect(
        withTestTenant(async () =>
          aiService.getForMeeting(meetingId, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // regenerate
  // ────────────────────────────────────────────────────────────────────
  describe('regenerate', () => {
    it('regenerate updates content + bumps generated_at on GENERATED row', async () => {
      const meetingId = await createMeeting();
      const first = await withTestTenant(async () =>
        aiService.generate(meetingId, { rawTranscript: 'v1' } as any, adminActor()),
      );
      const updated = await withTestTenant(async () =>
        aiService.regenerate(
          first.id,
          { rawTranscript: 'v2 longer transcript with more words' } as any,
          adminActor(),
        ),
      );
      expect(updated.rawTranscript).toContain('v2 longer');
      expect(updated.status).toBe('GENERATED');
    });

    it('regenerate uses prior transcript when input.rawTranscript missing', async () => {
      const meetingId = await createMeeting();
      const first = await withTestTenant(async () =>
        aiService.generate(meetingId, { rawTranscript: 'original text' } as any, adminActor()),
      );
      const re = await withTestTenant(async () =>
        aiService.regenerate(first.id, {} as any, adminActor()),
      );
      expect(re.rawTranscript).toBe('original text');
    });

    it('regenerate refused on APPROVED → BadRequestException', async () => {
      const meetingId = await createMeeting();
      const first = await withTestTenant(async () =>
        aiService.generate(meetingId, { rawTranscript: 'approve me' } as any, adminActor()),
      );
      await withTestTenant(async () => aiService.approve(first.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          aiService.regenerate(first.id, { rawTranscript: 'new content' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // approve
  // ────────────────────────────────────────────────────────────────────
  describe('approve', () => {
    it('approve flips GENERATED → APPROVED with approved_by + approved_at (lockstep)', async () => {
      const meetingId = await createMeeting();
      const generated = await withTestTenant(async () =>
        aiService.generate(meetingId, { rawTranscript: 'approve me' } as any, adminActor()),
      );
      const approved = await withTestTenant(async () =>
        aiService.approve(generated.id, adminActor()),
      );
      expect(approved.status).toBe('APPROVED');
      expect(approved.approvedBy).not.toBeNull();
      expect(approved.approvedAt).not.toBeNull();
    });

    it('approve refused on already-APPROVED → BadRequestException', async () => {
      const meetingId = await createMeeting();
      const generated = await withTestTenant(async () =>
        aiService.generate(meetingId, { rawTranscript: 'words' } as any, adminActor()),
      );
      await withTestTenant(async () => aiService.approve(generated.id, adminActor()));
      await expect(
        withTestTenant(async () => aiService.approve(generated.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('approve on missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          aiService.approve('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
