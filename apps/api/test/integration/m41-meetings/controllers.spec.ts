import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

// Controllers
import {
  MeetingController,
  ParticipantSlotController,
} from '@modules/m41-meetings/meetings/meeting.controller';
import { ConferenceController } from '@modules/m41-meetings/meetings/conference.controller';
import {
  ActionItemController,
  IepMeetingRecordController,
  MeetingTypeController,
  NotesAgendaController,
  RecordingController,
} from '@modules/m41-meetings/meetings/meeting-content.controller';
import { ClubsMeetingsAdvancedController } from '@modules/m41-meetings/meetings/clubs-meetings-advanced.controller';

// Services
import { MeetingService } from '@modules/m41-meetings/meetings/meeting.service';
import { SlotService } from '@modules/m41-meetings/meetings/slot.service';
import { ConferenceService } from '@modules/m41-meetings/meetings/conference.service';
import { MeetingNotesService } from '@modules/m41-meetings/meetings/meeting-notes.service';
import { AgendaService } from '@modules/m41-meetings/meetings/agenda.service';
import { ActionItemService } from '@modules/m41-meetings/meetings/action-item.service';
import { RecordingService } from '@modules/m41-meetings/recordings/recording.service';
import { IepMeetingRecordService } from '@modules/m41-meetings/meetings/iep-meeting-record.service';
import { MeetingTypeService } from '@modules/m41-meetings/meetings/meeting-type.service';
import { ServicePartnerService } from '@modules/m41-meetings/meetings/service-partner.service';
import { ClubBudgetService } from '@modules/m41-meetings/meetings/club-budget.service';
import { FieldTripEvalService } from '@modules/m41-meetings/meetings/field-trip-eval.service';
import { MeetingTemplateService } from '@modules/m41-meetings/templates/meeting-template.service';
import { AIMinutesService } from '@modules/m41-meetings/meetings/ai-minutes.service';

import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_MEETING_TYPE_ID } from '../fixtures/meetings';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * Wave 5 — m41-meetings controllers smoke. Exercises each controller
 * method against a real DB + real services to cover the thin
 * delegation layer.
 */
describe('integration:m41-meetings/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let permCheck: PermissionCheckService;
  let actors: ActorContextService;

  let meetingService: MeetingService;
  let slotService: SlotService;
  let conferenceService: ConferenceService;
  let notesService: MeetingNotesService;
  let agendaService: AgendaService;
  let actionService: ActionItemService;
  let recordingService: RecordingService;
  let iepService: IepMeetingRecordService;
  let typeService: MeetingTypeService;
  let partnerService: ServicePartnerService;
  let budgetService: ClubBudgetService;
  let tripEvalService: FieldTripEvalService;
  let templateService: MeetingTemplateService;
  let aiService: AIMinutesService;

  let meetingController: MeetingController;
  let participantSlotController: ParticipantSlotController;
  let conferenceController: ConferenceController;
  let notesAgendaController: NotesAgendaController;
  let actionItemController: ActionItemController;
  let recordingController: RecordingController;
  let iepController: IepMeetingRecordController;
  let typeController: MeetingTypeController;
  let advancedController: ClubsMeetingsAdvancedController;

  let activityTypeId: string;
  let activityId: string;
  let fieldTripId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    permCheck = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permCheck, tenantPrisma);

    meetingService = new MeetingService(tenantPrisma, outbox);
    slotService = new SlotService(tenantPrisma, meetingService);
    conferenceService = new ConferenceService(tenantPrisma);
    notesService = new MeetingNotesService(tenantPrisma, meetingService);
    agendaService = new AgendaService(tenantPrisma, meetingService);
    actionService = new ActionItemService(tenantPrisma, meetingService);
    recordingService = new RecordingService(tenantPrisma, meetingService);
    iepService = new IepMeetingRecordService(tenantPrisma, permCheck);
    typeService = new MeetingTypeService(tenantPrisma);
    partnerService = new ServicePartnerService(tenantPrisma);
    budgetService = new ClubBudgetService(tenantPrisma);
    tripEvalService = new FieldTripEvalService(tenantPrisma);
    templateService = new MeetingTemplateService(tenantPrisma);
    aiService = new AIMinutesService(tenantPrisma);

    meetingController = new MeetingController(meetingService, slotService, actors);
    participantSlotController = new ParticipantSlotController(meetingService, slotService, actors);
    conferenceController = new ConferenceController(conferenceService, actors);
    notesAgendaController = new NotesAgendaController(notesService, agendaService, actors);
    actionItemController = new ActionItemController(actionService, actors);
    recordingController = new RecordingController(recordingService, actors);
    iepController = new IepMeetingRecordController(iepService, actors);
    typeController = new MeetingTypeController(typeService);
    advancedController = new ClubsMeetingsAdvancedController(
      budgetService,
      tripEvalService,
      partnerService,
      templateService,
      aiService,
      actors,
    );

    // Seed activity + field trip rows. Read-or-create to survive a re-run
    // against a tenant_test schema that already has prior rows.
    const existingType = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_activity_types
        WHERE school_id = $1::uuid AND name = 'CtrlSmoke' LIMIT 1`,
      TEST_SCHOOL_ID,
    );
    if (existingType.length > 0) {
      activityTypeId = existingType[0]!.id;
    } else {
      activityTypeId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_activity_types (id, school_id, name, category)
         VALUES ($1::uuid, $2::uuid, 'CtrlSmoke', 'OTHER')`,
        activityTypeId,
        TEST_SCHOOL_ID,
      );
    }
    const existingActivity = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_activities
        WHERE school_id = $1::uuid AND name = 'CtrlClub' LIMIT 1`,
      TEST_SCHOOL_ID,
    );
    if (existingActivity.length > 0) {
      activityId = existingActivity[0]!.id;
    } else {
      activityId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_activities (id, school_id, activity_type_id, name, academic_year_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CtrlClub', $4::uuid, 'ACTIVE')`,
        activityId,
        TEST_SCHOOL_ID,
        activityTypeId,
        TEST_SIS_ACADEMIC_YEAR_ID,
      );
    }
    const existingTrip = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_field_trips
        WHERE school_id = $1::uuid AND title = 'Ctrl trip' LIMIT 1`,
      TEST_SCHOOL_ID,
    );
    if (existingTrip.length > 0) {
      fieldTripId = existingTrip[0]!.id;
    } else {
      fieldTripId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trips (id, school_id, title, destination, trip_date, organiser_id, status)
         VALUES ($1::uuid, $2::uuid, 'Ctrl trip', 'Place', '2026-10-15', $3::uuid, 'COMPLETED')`,
        fieldTripId,
        TEST_SCHOOL_ID,
        '019e0cf8-aaaa-7777-8888-000000000012', // TEST_ADMIN_EMPLOYEE_ID
      );
    }

    // Seed admin's iam_effective_access_cache so ActorContextService.resolveActor
    // returns isSchoolAdmin=true via the sch-001:admin code.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'ctrl-test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      ['sch-001:admin', 'cou-001:write'],
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.mtg_ai_minutes`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.mtg_iep_meeting_records`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.mtg_meeting_slots`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_meetings WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_conference_events WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_meeting_templates WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.ext_service_partner_orgs WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.ext_budget_transactions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.ext_club_budgets`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.ext_field_trip_evaluations`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'mtg.meeting.scheduled' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  function adminReq(): any {
    return {
      user: { sub: TEST_ADMIN_ACCOUNT_ID, personId: TEST_ADMIN_PERSON_ID, email: 'admin@test' },
    };
  }
  function parentReq(): any {
    return {
      user: { sub: TEST_PARENT_ACCOUNT_ID, personId: TEST_PARENT_PERSON_ID, email: 'parent@test' },
    };
  }

  // ─────────────────────────────────────────────────────────────
  describe('MeetingController + ParticipantSlotController', () => {
    it('create / list / getById / patch', async () => {
      const created = await withTestTenant(async () =>
        meetingController.create(adminReq(), {
          meetingTypeId: TEST_MEETING_TYPE_ID,
          title: 'Ctrl smoke',
          scheduledAt: '2026-06-20T15:00:00Z',
          durationMinutes: 30,
          participantIds: [TEST_TEACHER_ACCOUNT_ID],
        } as any),
      );
      expect(created.title).toBe('Ctrl smoke');

      const list = await withTestTenant(async () =>
        meetingController.list(adminReq(), undefined, undefined, undefined, undefined),
      );
      expect(list.map((m) => m.id)).toContain(created.id);

      const fetched = await withTestTenant(async () =>
        meetingController.getById(adminReq(), created.id),
      );
      expect(fetched.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        meetingController.patch(adminReq(), created.id, { title: 'renamed' } as any),
      );
      expect(patched.title).toBe('renamed');
    });

    it('addParticipant on the parent (no tenant projection) fails — try teacher works', async () => {
      const created = await withTestTenant(async () =>
        meetingController.create(adminReq(), {
          meetingTypeId: TEST_MEETING_TYPE_ID,
          title: 'add part',
          scheduledAt: '2026-06-20T15:00:00Z',
          durationMinutes: 30,
        } as any),
      );
      // Add teacher (has hr_employees row)
      const added = await withTestTenant(async () =>
        meetingController.addParticipant(adminReq(), created.id, {
          participantId: TEST_TEACHER_ACCOUNT_ID,
        } as any),
      );
      expect(added.participantId).toBe(TEST_TEACHER_ACCOUNT_ID);

      // Remove
      const removed = await withTestTenant(async () =>
        participantSlotController.removeParticipant(adminReq(), added.id),
      );
      expect(removed.removed).toBe(true);
    });

    it('slot endpoints: createSlots + listSlots + book + cancel', async () => {
      const m = await withTestTenant(async () =>
        meetingController.create(adminReq(), {
          meetingTypeId: TEST_MEETING_TYPE_ID,
          title: 'slot ctrl',
          scheduledAt: '2026-10-02T15:00:00Z',
          durationMinutes: 30,
        } as any),
      );
      const slots = await withTestTenant(async () =>
        meetingController.createSlots(adminReq(), m.id, {
          slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
        } as any),
      );
      expect(slots).toHaveLength(1);

      const slotList = await withTestTenant(async () =>
        meetingController.listSlots(adminReq(), m.id),
      );
      expect(slotList).toHaveLength(1);

      // Parent books
      const booked = await withTestTenant(async () =>
        participantSlotController.book(parentReq(), slots[0]!.id),
      );
      expect(booked.isBooked).toBe(true);

      // Parent cancels
      const cancelled = await withTestTenant(async () =>
        participantSlotController.cancel(parentReq(), slots[0]!.id),
      );
      expect(cancelled.isBooked).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('ConferenceController', () => {
    it('list / getById / create / patch', async () => {
      const created = await withTestTenant(async () =>
        conferenceController.create(adminReq(), {
          title: 'PTC Ctrl',
          conferenceType: 'PARENT_TEACHER',
          startDate: '2026-10-01',
          endDate: '2026-10-02',
        } as any),
      );
      expect(created.title).toBe('PTC Ctrl');

      const list = await withTestTenant(async () => conferenceController.list());
      expect(list.map((c) => c.id)).toContain(created.id);

      const fetched = await withTestTenant(async () => conferenceController.getById(created.id));
      expect(fetched.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        conferenceController.patch(adminReq(), created.id, { title: 'renamed' } as any),
      );
      expect(patched.title).toBe('renamed');

      await expect(
        withTestTenant(async () =>
          conferenceController.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('MeetingTypeController', () => {
    it('list + getById', async () => {
      const list = await withTestTenant(async () => typeController.list());
      expect(list.length).toBeGreaterThan(0);

      const fetched = await withTestTenant(async () =>
        typeController.getById(TEST_MEETING_TYPE_ID),
      );
      expect(fetched.id).toBe(TEST_MEETING_TYPE_ID);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('NotesAgendaController + ActionItemController + RecordingController + IepMeetingRecordController', () => {
    async function newMeeting(): Promise<string> {
      const m = await withTestTenant(async () =>
        meetingController.create(adminReq(), {
          meetingTypeId: TEST_MEETING_TYPE_ID,
          title: 'content meet',
          scheduledAt: '2026-06-20T15:00:00Z',
          durationMinutes: 30,
          participantIds: [TEST_TEACHER_ACCOUNT_ID],
        } as any),
      );
      return m.id;
    }

    it('notes CRUD: get null → upsert → patch → approve', async () => {
      const id = await newMeeting();
      const empty = await withTestTenant(async () =>
        notesAgendaController.getNotes(adminReq(), id),
      );
      expect(empty).toBeNull();

      const notes = await withTestTenant(async () =>
        notesAgendaController.upsertNotes(adminReq(), id, {
          notesText: 'ctrl notes',
        } as any),
      );
      expect(notes.notesText).toBe('ctrl notes');

      const patched = await withTestTenant(async () =>
        notesAgendaController.patchNotes(adminReq(), notes.id, {
          notesText: 'updated',
        } as any),
      );
      expect(patched.notesText).toBe('updated');

      const approved = await withTestTenant(async () =>
        notesAgendaController.approveNotes(adminReq(), notes.id),
      );
      expect(approved.isApproved).toBe(true);
    });

    it('agenda CRUD: list + create + patch + remove', async () => {
      const id = await newMeeting();
      const item = await withTestTenant(async () =>
        notesAgendaController.createAgenda(adminReq(), id, {
          title: 'Item',
          sortOrder: 0,
        } as any),
      );
      expect(item.title).toBe('Item');

      const list = await withTestTenant(async () =>
        notesAgendaController.listAgenda(adminReq(), id),
      );
      expect(list.map((i) => i.id)).toContain(item.id);

      const patched = await withTestTenant(async () =>
        notesAgendaController.patchAgenda(adminReq(), item.id, {
          title: 'Renamed',
        } as any),
      );
      expect(patched.title).toBe('Renamed');

      await withTestTenant(async () => notesAgendaController.deleteAgenda(adminReq(), item.id));
    });

    it('action item CRUD: create + list + listMine + patch', async () => {
      const id = await newMeeting();
      const created = await withTestTenant(async () =>
        actionItemController.create(adminReq(), id, {
          assigneeId: TEST_TEACHER_ACCOUNT_ID,
          description: 'todo',
        } as any),
      );
      expect(created.description).toBe('todo');

      const list = await withTestTenant(async () =>
        actionItemController.listForMeeting(adminReq(), id),
      );
      expect(list.map((i) => i.id)).toContain(created.id);

      const mine = await withTestTenant(async () =>
        actionItemController.listMine(adminReq(), undefined),
      );
      expect(Array.isArray(mine)).toBe(true);

      const patched = await withTestTenant(async () =>
        actionItemController.patch(adminReq(), created.id, { status: 'DONE' } as any),
      );
      expect(patched.status).toBe('DONE');
    });

    it('recording CRUD: get null → create → consent → get with consent', async () => {
      const id = await newMeeting();
      const empty = await withTestTenant(async () =>
        recordingController.getForMeeting(adminReq(), id),
      );
      expect(empty).toBeNull();

      const rec = await withTestTenant(async () =>
        recordingController.create(adminReq(), id, { s3Key: 's3://r' } as any),
      );
      expect(rec.status).toBe('PROCESSING');

      const consent = await withTestTenant(async () =>
        recordingController.giveConsent(adminReq(), rec.id, {
          consentGiven: true,
        } as any),
      );
      expect(consent.consentGiven).toBe(true);
    });

    it('IEP meeting record CRUD', async () => {
      const meetingId = await newMeeting();
      // Seed student
      const personId = generateId();
      const platformStudentId = generateId();
      const sid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'C', 'S', 'STUDENT', true)`,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'C', 'S', true)`,
        platformStudentId,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
        sid,
        platformStudentId,
        TEST_SCHOOL_ID,
        'IEPCTRL-' + sid.slice(-6),
      );
      try {
        const created = await withTestTenant(async () =>
          iepController.create(adminReq(), meetingId, { studentId: sid } as any),
        );
        expect(created.studentId).toBe(sid);

        const list = await withTestTenant(async () => iepController.list(adminReq()));
        expect(list.length).toBeGreaterThan(0);

        const fetched = await withTestTenant(async () =>
          iepController.getForMeeting(adminReq(), meetingId),
        );
        expect(fetched?.id).toBe(created.id);

        const patched = await withTestTenant(async () =>
          iepController.patch(adminReq(), created.id, { outcomesSummary: 'done' } as any),
        );
        expect(patched.outcomesSummary).toBe('done');
      } finally {
        await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.mtg_iep_meeting_records`);
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid`,
          sid,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM platform.platform_students WHERE id = $1::uuid`,
          platformStudentId,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
          personId,
        );
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('ClubsMeetingsAdvancedController', () => {
    it('service partner CRUD', async () => {
      const created = await withTestTenant(async () =>
        advancedController.createPartner({ orgName: 'CtrlPartner' } as any, adminReq()),
      );
      expect(created.orgName).toBe('CtrlPartner');

      const list = await withTestTenant(async () =>
        advancedController.listPartners(undefined, adminReq()),
      );
      expect(list.map((p) => p.id)).toContain(created.id);

      const fetched = await withTestTenant(async () =>
        advancedController.getPartner(created.id, adminReq()),
      );
      expect(fetched.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        advancedController.patchPartner(created.id, { orgName: 'Renamed' } as any, adminReq()),
      );
      expect(patched.orgName).toBe('Renamed');
    });

    it('club budget CRUD + transaction', async () => {
      const created = await withTestTenant(async () =>
        advancedController.createBudget(
          {
            activityId,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            allocatedAmount: 1000,
          } as any,
          adminReq(),
        ),
      );
      expect(created.allocatedAmount).toBe(1000);

      const list = await withTestTenant(async () =>
        advancedController.listBudgets(undefined, adminReq()),
      );
      expect(list.map((b) => b.id)).toContain(created.id);

      const fetched = await withTestTenant(async () =>
        advancedController.getBudget(created.id, adminReq()),
      );
      expect(fetched.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        advancedController.patchBudget(created.id, { notes: 'new note' } as any, adminReq()),
      );
      expect(patched.notes).toBe('new note');

      const tx = await withTestTenant(async () =>
        advancedController.recordTransaction(
          created.id,
          { transactionType: 'EXPENSE', amount: 100, description: 'snacks' } as any,
          adminReq(),
        ),
      );
      expect(tx.amount).toBe(100);

      const txList = await withTestTenant(async () =>
        advancedController.listTransactions(created.id, adminReq()),
      );
      expect(txList).toHaveLength(1);
    });

    it('field trip evaluation CRUD', async () => {
      const created = await withTestTenant(async () =>
        advancedController.createEvaluation(fieldTripId, { overallRating: 5 } as any, adminReq()),
      );
      expect(created.overallRating).toBe(5);

      const list = await withTestTenant(async () =>
        advancedController.listEvaluations(fieldTripId, adminReq()),
      );
      expect(list.map((e) => e.id)).toContain(created.id);

      const summary = await withTestTenant(async () =>
        advancedController.evaluationsSummary(fieldTripId, adminReq()),
      );
      expect(summary.evaluationCount).toBe(1);
    });

    it('meeting template CRUD + create-from-template', async () => {
      const created = await withTestTenant(async () =>
        advancedController.createTemplate(
          {
            name: 'CtrlTemplate',
            meetingTypeId: TEST_MEETING_TYPE_ID,
            defaultAgenda: [{ title: 'Hello' }],
          } as any,
          adminReq(),
        ),
      );
      expect(created.name).toBe('CtrlTemplate');

      const list = await withTestTenant(async () =>
        advancedController.listTemplates(undefined, adminReq()),
      );
      expect(list.map((t) => t.id)).toContain(created.id);

      const fetched = await withTestTenant(async () =>
        advancedController.getTemplate(created.id, adminReq()),
      );
      expect(fetched.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        advancedController.patchTemplate(created.id, { description: 'updated' } as any, adminReq()),
      );
      expect(patched.description).toBe('updated');

      const result = await withTestTenant(async () =>
        advancedController.createMeetingFromTemplate(
          created.id,
          { title: 'from template', scheduledAt: '2026-06-25T15:00:00Z' } as any,
          adminReq(),
        ),
      );
      expect(result.meetingId).toBeDefined();
      expect(result.agendaItemsCreated).toBe(1);
    });

    it('AI minutes CRUD: get null → generate → regenerate → approve', async () => {
      const meetingId = (
        await withTestTenant(async () =>
          meetingController.create(adminReq(), {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'AI ctrl',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
          } as any),
        )
      ).id;
      const empty = await withTestTenant(async () =>
        advancedController.getMinutesForMeeting(meetingId, adminReq()),
      );
      expect(empty).toBeNull();

      const generated = await withTestTenant(async () =>
        advancedController.generateMinutes(
          meetingId,
          { rawTranscript: 'some words' } as any,
          adminReq(),
        ),
      );
      expect(generated.status).toBe('GENERATED');

      const re = await withTestTenant(async () =>
        advancedController.regenerateMinutes(
          generated.id,
          { rawTranscript: 'new words' } as any,
          adminReq(),
        ),
      );
      expect(re.rawTranscript).toContain('new words');

      const approved = await withTestTenant(async () =>
        advancedController.approveMinutes(generated.id, adminReq()),
      );
      expect(approved.status).toBe('APPROVED');
    });
  });

  void NotFoundException;
});
