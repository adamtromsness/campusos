import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import {
  VisitorTypeService,
  VisitorService,
  SignInSettingsService,
} from '@modules/m90-visitors/visitor.service';
import {
  SignInService,
  PreRegistrationService,
  RecurringVisitorService,
} from '@modules/m90-visitors/sign-in.service';
import { BannedPersonService } from '@modules/m90-visitors/banned-person.service';
import { MusterService } from '@modules/m90-visitors/muster.service';
import { VisitorMusterConsumer } from '@modules/m90-visitors/visitor-muster.consumer';
import { VisitorsController } from '@modules/m90-visitors/visitors.controller';
import {
  encryptPII,
  decryptPII,
  emailHash,
  phoneHash,
  nameHash,
  normaliseNameComponent,
  generateQrToken,
} from '@modules/m90-visitors/crypto';
import { ActorContextService, PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { ensureWorkflowsPlatformFixtures } from '../fixtures/workflows';
import {
  resetAndSeedVisitors,
  resetVisitorsTables,
  TEST_VIS_TYPE_CONTRACTOR_A_ID,
  TEST_VIS_TYPE_PARENT_A_ID,
  TEST_VIS_TYPE_RETIRED_A_ID,
  TEST_VIS_TYPE_CONTRACTOR_B_ID,
} from '../fixtures/visitors';
import { generateId } from '@campusos/database';

describe('integration:m90-visitors/visitor-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let visitorTypes: VisitorTypeService;
  let visitors: VisitorService;
  let settings: SignInSettingsService;
  let signIn: SignInService;
  let preReg: PreRegistrationService;
  let recurring: RecurringVisitorService;
  let banned: BannedPersonService;
  let muster: MusterService;
  let consumer: VisitorMusterConsumer;
  let ctrl: VisitorsController;
  let kafka: RecordingKafkaProducer;
  let actors: ActorContextService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka() as any;
    const permCheck = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permCheck, tenantPrisma);
    visitorTypes = new VisitorTypeService(tenantPrisma, permCheck);
    visitors = new VisitorService(tenantPrisma, permCheck, visitorTypes);
    settings = new SignInSettingsService(tenantPrisma, permCheck);
    banned = new BannedPersonService(tenantPrisma, permCheck, kafka as any);
    signIn = new SignInService(
      tenantPrisma,
      permCheck,
      kafka as any,
      visitors,
      visitorTypes,
      banned,
    );
    preReg = new PreRegistrationService(tenantPrisma, permCheck, visitors, visitorTypes, signIn);
    recurring = new RecurringVisitorService(tenantPrisma, permCheck, visitors);
    muster = new MusterService(tenantPrisma, permCheck, kafka as any);
    consumer = new VisitorMusterConsumer({} as any, {} as any, tenantPrisma);
    ctrl = new VisitorsController(
      visitorTypes,
      visitors,
      settings,
      signIn,
      preReg,
      recurring,
      banned,
      muster,
      actors,
    );
    await ensureWorkflowsPlatformFixtures(rawClient);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeedVisitors(rawClient);
    kafka.reset();
  });

  // ───────────────────────────────────────────────────────────────────
  // crypto
  // ───────────────────────────────────────────────────────────────────
  describe('crypto', () => {
    it('encrypt/decrypt round-trip preserves plaintext', () => {
      const enc = encryptPII('hello@example.com');
      expect(enc).toBeTruthy();
      expect(decryptPII(enc!)).toBe('hello@example.com');
    });

    it('encryptPII null/empty → null', () => {
      expect(encryptPII(null)).toBeNull();
      expect(encryptPII('')).toBeNull();
      expect(decryptPII(null)).toBeNull();
    });

    it('decryptPII throws on malformed', () => {
      expect(() => decryptPII('not.valid')).toThrow();
    });

    it('emailHash is school-scoped + case-insensitive', () => {
      const a = emailHash(TEST_SCHOOL_ID, 'JOE@example.com');
      const b = emailHash(TEST_SCHOOL_ID, 'joe@example.com');
      const c = emailHash(TEST_SCHOOL_B_ID, 'joe@example.com');
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });

    it('phoneHash normalises non-digits + returns null for empty', () => {
      expect(phoneHash(TEST_SCHOOL_ID, null)).toBeNull();
      expect(phoneHash(TEST_SCHOOL_ID, '   ')).toBeNull();
      // pure punctuation collapses to empty → null
      expect(phoneHash(TEST_SCHOOL_ID, '()()()')).toBeNull();
      const a = phoneHash(TEST_SCHOOL_ID, '(555) 123-4567');
      const b = phoneHash(TEST_SCHOOL_ID, '5551234567');
      expect(a).toBe(b);
    });

    it('nameHash normalises + binds DOB + binds school', () => {
      const a = nameHash(TEST_SCHOOL_ID, 'José', "O'Brien");
      const b = nameHash(TEST_SCHOOL_ID, 'jose', 'o brien');
      expect(a).toBe(b);
      const withDob = nameHash(TEST_SCHOOL_ID, 'Jose', 'OBrien', '1990-01-01');
      expect(withDob).not.toBe(a);
      const fromB = nameHash(TEST_SCHOOL_B_ID, 'jose', 'o brien');
      expect(fromB).not.toBe(a);
    });

    it('normaliseNameComponent strips punctuation + diacritics', () => {
      expect(normaliseNameComponent("O'Brien-Smith  ")).toBe('o brien smith');
      expect(normaliseNameComponent('José')).toBe('jose');
    });

    it('generateQrToken returns 64-char hex', () => {
      const t = generateQrToken();
      expect(t).toMatch(/^[a-f0-9]{64}$/);
      expect(generateQrToken()).not.toBe(t);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // VisitorTypeService
  // ───────────────────────────────────────────────────────────────────
  describe('VisitorTypeService', () => {
    it('list excludes inactive by default', async () => {
      const list = await withTestTenant(async () => visitorTypes.list(adminActor()));
      expect(list.map((v) => v.id)).toContain(TEST_VIS_TYPE_CONTRACTOR_A_ID);
      expect(list.map((v) => v.id)).not.toContain(TEST_VIS_TYPE_RETIRED_A_ID);
    });

    it('list with includeInactive=true returns retired too', async () => {
      const all = await withTestTenant(async () => visitorTypes.list(adminActor(), true));
      expect(all.map((v) => v.id)).toContain(TEST_VIS_TYPE_RETIRED_A_ID);
    });

    it('cross-school: B types not visible from A', async () => {
      const list = await withTestTenant(async () => visitorTypes.list(adminActor(), true));
      expect(list.map((v) => v.id)).not.toContain(TEST_VIS_TYPE_CONTRACTOR_B_ID);
    });

    it('create + patch + duplicate conflict', async () => {
      const dto = await withTestTenant(async () =>
        visitorTypes.create({ name: 'Inspector', badgeColor: 'purple' } as any, adminActor()),
      );
      expect(dto.name).toBe('Inspector');
      // Duplicate name → 409
      await expect(
        withTestTenant(async () => visitorTypes.create({ name: 'Inspector' } as any, adminActor())),
      ).rejects.toBeInstanceOf(ConflictException);
      // Patch
      const patched = await withTestTenant(async () =>
        visitorTypes.patch(dto.id, { name: 'Auditor' } as any, adminActor()),
      );
      expect(patched.name).toBe('Auditor');
      // Patch toggle isActive + other fields
      const togg = await withTestTenant(async () =>
        visitorTypes.patch(
          dto.id,
          {
            description: 'd',
            requiresSafeguardingCheck: false,
            badgeColor: 'green',
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      expect(togg.isActive).toBe(false);
      // Patch with no fields → BadRequest
      await expect(
        withTestTenant(async () => visitorTypes.patch(dto.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('loadOrFail rejects inactive', async () => {
      await expect(
        withTestTenant(async () => visitorTypes.loadOrFail(TEST_VIS_TYPE_RETIRED_A_ID)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('loadOrFail missing → 404', async () => {
      await expect(
        withTestTenant(async () => visitorTypes.loadOrFail('00000000-0000-0000-0000-000000000099')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create gated for non-admin without saf-002:admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () => visitorTypes.create({ name: 'X' } as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // VisitorService
  // ───────────────────────────────────────────────────────────────────
  describe('VisitorService', () => {
    async function newVisitor(opts: { schoolId?: string; email?: string; name?: string } = {}) {
      const id = generateId();
      const schoolId = opts.schoolId ?? TEST_SCHOOL_ID;
      const typeId =
        schoolId === TEST_SCHOOL_B_ID
          ? TEST_VIS_TYPE_CONTRACTOR_B_ID
          : TEST_VIS_TYPE_CONTRACTOR_A_ID;
      const email = opts.email ?? `v${id.slice(-6)}@x.local`;
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.vis_visitors
           (id, school_id, visitor_type_id, first_name, last_name, company,
            email_encrypted, email_hash, phone_encrypted, phone_hash, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'Tester', 'Acme',
                 $5, $6, NULL, NULL, NULL)`,
        id,
        schoolId,
        typeId,
        opts.name ?? 'Vince',
        encryptPII(email),
        emailHash(schoolId, email),
      );
      return { id, email };
    }

    it('list returns school A visitors with search filter', async () => {
      await newVisitor({ name: 'Alpha' });
      await newVisitor({ name: 'Beta' });
      const list = await withTestTenant(async () => visitors.list(adminActor()));
      expect(list.length).toBeGreaterThanOrEqual(2);
      const filtered = await withTestTenant(async () => visitors.list(adminActor(), 'Alpha'));
      expect(filtered.every((v) => v.firstName === 'Alpha' || v.lastName.includes('Alpha'))).toBe(
        true,
      );
    });

    it('lookupByEmail finds returning visitor — returns null when not found', async () => {
      const { email } = await newVisitor();
      const found = await withTestTenant(async () => visitors.lookupByEmail(email));
      expect(found?.id).toBeTruthy();
      const miss = await withTestTenant(async () => visitors.lookupByEmail('nope@nope.com'));
      expect(miss).toBeNull();
    });

    it('getById returns full visitor with decrypted email', async () => {
      const { id, email } = await newVisitor();
      const dto = await withTestTenant(async () => visitors.getById(id, adminActor()));
      expect(dto.id).toBe(id);
      expect((dto as any).email).toBe(email);
    });

    it('getById missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          visitors.getById('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create + duplicate email → returns existing visitor (idempotent)', async () => {
      const dto = await withTestTenant(async () =>
        visitors.create(
          {
            visitorTypeId: TEST_VIS_TYPE_CONTRACTOR_A_ID,
            firstName: 'New',
            lastName: 'Visit',
            email: 'newv@x.local',
            phone: '555-1234',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.firstName).toBe('New');
      // Second call with same email returns the same visitor (idempotent
      // kiosk lookup pattern).
      const dup = await withTestTenant(async () =>
        visitors.create(
          {
            visitorTypeId: TEST_VIS_TYPE_CONTRACTOR_A_ID,
            firstName: 'Dup',
            lastName: 'Visit',
            email: 'newv@x.local',
          } as any,
          adminActor(),
        ),
      );
      expect(dup.id).toBe(dto.id);
    });

    it('patch updates select fields', async () => {
      const { id } = await newVisitor();
      const patched = await withTestTenant(async () =>
        visitors.patch(
          id,
          { firstName: 'Updated', company: 'NewCo', phone: '999-0001' } as any,
          adminActor(),
        ),
      );
      expect(patched.firstName).toBe('Updated');
      expect(patched.company).toBe('NewCo');
    });

    it('loadInternal rejects cross-school visitor → 404', async () => {
      const { id } = await newVisitor({ schoolId: TEST_SCHOOL_B_ID });
      await expect(withTestTenant(async () => visitors.loadInternal(id))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // SignInSettingsService
  // ───────────────────────────────────────────────────────────────────
  describe('SignInSettingsService', () => {
    it('get returns the school settings', async () => {
      const dto = await withTestTenant(async () => settings.get());
      expect(dto.requirePurpose).toBe(true);
      expect(dto.badgeTemplate).toBe('STANDARD');
    });

    it('update mutates fields', async () => {
      const dto = await withTestTenant(async () =>
        settings.update(
          {
            requirePhotoId: true,
            requirePurpose: false,
            autoSignOutHours: 6,
            kioskWelcomeMessage: 'Hi there',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.requirePhotoId).toBe(true);
      expect(dto.autoSignOutHours).toBe(6);
      expect(dto.kioskWelcomeMessage).toBe('Hi there');
    });

    it('update requires admin', async () => {
      await expect(
        withTestTenant(async () =>
          settings.update({ requirePurpose: true } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: B settings invisible from A', async () => {
      const fromA = await withTestTenant(async () => settings.get());
      const fromB = await withTestTenantB(async () => settings.get());
      expect(fromA.kioskWelcomeMessage).not.toBe(fromB.kioskWelcomeMessage);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // SignInService
  // ───────────────────────────────────────────────────────────────────
  describe('SignInService', () => {
    it('create with new visitor — emits vis.visitor.signed_in', async () => {
      const dto = await withTestTenant(async () =>
        signIn.create(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'New',
            lastName: 'Walkin',
            email: 'walkin@x.local',
            purpose: 'Test',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.signedOutAt).toBeNull();
      const emit = kafka.callsForTopic('vis.visitor.signed_in');
      expect(emit).toHaveLength(1);
    });

    it('create without visitor identification → BadRequest', async () => {
      await expect(
        withTestTenant(async () => signIn.create({} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create with safeguarding-required type but no ref → status=FLAGGED', async () => {
      const dto = await withTestTenant(async () =>
        signIn.create(
          {
            visitorTypeId: TEST_VIS_TYPE_CONTRACTOR_A_ID,
            firstName: 'Cont',
            lastName: 'Ractor',
            email: 'cr@x.local',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.safeguardingCheckStatus).toBe('FLAGGED');
    });

    it('create with safeguarding-required + ref → status=PASSED', async () => {
      const dto = await withTestTenant(async () =>
        signIn.create(
          {
            visitorTypeId: TEST_VIS_TYPE_CONTRACTOR_A_ID,
            firstName: 'Cont',
            lastName: 'Pass',
            email: 'cp@x.local',
            safeguardingCheckRef: 'SC-001',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.safeguardingCheckStatus).toBe('PASSED');
    });

    it('create blocked when banned-person match', async () => {
      // Seed a banned person matching name.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.vis_banned_persons
           (id, school_id, first_name, last_name, name_hash, ban_reason, ban_type, added_by, is_active)
         VALUES (gen_random_uuid(), $1::uuid, 'Bad', 'Guy', $2, 'rsn', 'SAFEGUARDING', $3::uuid, true)`,
        TEST_SCHOOL_ID,
        nameHash(TEST_SCHOOL_ID, 'Bad', 'Guy'),
        TEST_ADMIN_ACCOUNT_ID,
      );
      await expect(
        withTestTenant(async () =>
          signIn.create(
            {
              visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
              firstName: 'Bad',
              lastName: 'Guy',
              email: 'bg@x.local',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('signOut flips signed_out_at; rejects double sign-out', async () => {
      const dto = await withTestTenant(async () =>
        signIn.create(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'A',
            lastName: 'B',
            email: 'a@x.local',
          } as any,
          adminActor(),
        ),
      );
      const out = await withTestTenant(async () => signIn.signOut(dto.id, adminActor()));
      expect(out.signedOutAt).not.toBeNull();
      await expect(
        withTestTenant(async () => signIn.signOut(dto.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bypassSafeguarding — admin only + reason length', async () => {
      const dto = await withTestTenant(async () =>
        signIn.create(
          {
            visitorTypeId: TEST_VIS_TYPE_CONTRACTOR_A_ID,
            firstName: 'Bp',
            lastName: 'Tester',
            email: 'bp@x.local',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          signIn.bypassSafeguarding(dto.id, { reason: 'short' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const bypassed = await withTestTenant(async () =>
        signIn.bypassSafeguarding(
          dto.id,
          { reason: 'A long enough reason to bypass' } as any,
          adminActor(),
        ),
      );
      expect(bypassed.safeguardingCheckStatus).toBe('BYPASSED_BY_ADMIN');
      await expect(
        withTestTenant(async () =>
          signIn.bypassSafeguarding(
            dto.id,
            { reason: 'still long enough reason' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listOnSite returns only active rows', async () => {
      const a = await withTestTenant(async () =>
        signIn.create(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'On',
            lastName: 'Site',
            email: 'on@x.local',
          } as any,
          adminActor(),
        ),
      );
      const b = await withTestTenant(async () =>
        signIn.create(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'Off',
            lastName: 'Site',
            email: 'off@x.local',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => signIn.signOut(b.id, adminActor()));
      const on = await withTestTenant(async () => signIn.listOnSite());
      expect(on.map((s) => s.id)).toContain(a.id);
      expect(on.map((s) => s.id)).not.toContain(b.id);
    });

    it('list applies fromDate/toDate/hostId/visitorId/onSiteOnly + limit', async () => {
      const dto = await withTestTenant(async () =>
        signIn.create(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'L',
            lastName: 'X',
            email: 'lx@x.local',
          } as any,
          adminActor(),
        ),
      );
      const filtered = await withTestTenant(async () =>
        signIn.list({ visitorId: dto.visitorId, onSiteOnly: true, limit: 10 } as any),
      );
      expect(filtered.map((s) => s.id)).toContain(dto.id);
      // Date filter
      const future = await withTestTenant(async () =>
        signIn.list({ fromDate: '2030-01-01T00:00:00Z' } as any),
      );
      expect(future).toHaveLength(0);
    });

    it('getById returns 404 for missing', async () => {
      await expect(
        withTestTenant(async () => signIn.getById('00000000-0000-0000-0000-000000000099')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listActiveForMuster returns rows for snapshot', async () => {
      await withTestTenant(async () =>
        signIn.create(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'M',
            lastName: 'M',
            email: 'mm@x.local',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => signIn.listActiveForMuster());
      expect(list.length).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // PreRegistrationService + RecurringVisitorService
  // ───────────────────────────────────────────────────────────────────
  describe('PreRegistrationService + Recurring', () => {
    it('preReg create + list + cancel', async () => {
      const dto = await withTestTenant(async () =>
        preReg.create(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'Pre',
            lastName: 'Reg',
            email: 'pre@x.local',
            expectedAt: new Date(Date.now() + 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          } as any,
          adminActor(),
        ),
      );
      expect(dto.qrCodeToken).toBeTruthy();
      const list = await withTestTenant(async () => preReg.list());
      expect(list.map((p) => p.id)).toContain(dto.id);
      await withTestTenant(async () => preReg.cancel(dto.id, adminActor()));
    });

    it('preReg scan resolves into a sign-in', async () => {
      const dto = await withTestTenant(async () =>
        preReg.create(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'Sc',
            lastName: 'An',
            email: 'sc@x.local',
            expectedAt: new Date(Date.now() + 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          } as any,
          adminActor(),
        ),
      );
      const si = await withTestTenant(async () =>
        preReg.scan({ qrCodeToken: dto.qrCodeToken } as any, adminActor()),
      );
      expect(si.signedOutAt).toBeNull();
    });

    it('preReg scan with bogus token → 404', async () => {
      await expect(
        withTestTenant(async () =>
          preReg.scan({ qrCodeToken: 'a'.repeat(64) } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('recurring CRUD', async () => {
      const v = await withTestTenant(async () =>
        visitors.create(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'R',
            lastName: 'V',
            email: 'rv@x.local',
          } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        recurring.create(
          {
            visitorId: v.id,
            accessSchedule: { days: ['MON'] },
            validFrom: '2026-01-01',
          } as any,
          adminActor(),
        ),
      );
      expect(r.id).toBeTruthy();
      const list = await withTestTenant(async () => recurring.list());
      expect(list.map((x) => x.id)).toContain(r.id);
      const today = await withTestTenant(async () => recurring.listToday());
      expect(Array.isArray(today)).toBe(true);
      const patched = await withTestTenant(async () =>
        recurring.patch(r.id, { notes: 'Updated' } as any, adminActor()),
      );
      expect(patched.notes).toBe('Updated');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // BannedPersonService
  // ───────────────────────────────────────────────────────────────────
  describe('BannedPersonService', () => {
    it('create + list + getById + patch + checkAtKiosk', async () => {
      const dto = await withTestTenant(async () =>
        banned.create(
          {
            firstName: 'No',
            lastName: 'Way',
            banReason: 'because',
            banType: 'SAFEGUARDING',
            effectiveFrom: '2026-01-01',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.id).toBeTruthy();
      const list = await withTestTenant(async () => banned.list(adminActor()));
      expect(list.map((b) => b.id)).toContain(dto.id);

      const fetched = await withTestTenant(async () => banned.getById(dto.id, adminActor()));
      expect(fetched.id).toBe(dto.id);

      const patched = await withTestTenant(async () =>
        banned.patch(dto.id, { notes: 'updated', isActive: false } as any, adminActor()),
      );
      expect(patched.isActive).toBe(false);

      // Inactive ban → kiosk check passes
      const check = await withTestTenant(async () =>
        banned.checkAtKiosk({ firstName: 'No', lastName: 'Way' }, adminActor()),
      );
      expect(check.blocked).toBe(false);

      // Reactivate + check blocked
      await withTestTenant(async () =>
        banned.patch(dto.id, { isActive: true } as any, adminActor()),
      );
      const check2 = await withTestTenant(async () =>
        banned.checkAtKiosk({ firstName: 'No', lastName: 'Way' }, adminActor()),
      );
      expect(check2.blocked).toBe(true);
    });

    it('list includeInactive=true returns inactive too', async () => {
      const dto = await withTestTenant(async () =>
        banned.create(
          {
            firstName: 'In',
            lastName: 'Active',
            banReason: 'r',
            banType: 'OTHER',
            effectiveFrom: '2026-01-01',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        banned.patch(dto.id, { isActive: false } as any, adminActor()),
      );
      const all = await withTestTenant(async () => banned.list(adminActor(), true));
      expect(all.map((b) => b.id)).toContain(dto.id);
      const active = await withTestTenant(async () => banned.list(adminActor(), false));
      expect(active.map((b) => b.id)).not.toContain(dto.id);
    });

    it('non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          banned.create(
            {
              firstName: 'X',
              lastName: 'Y',
              banReason: 'r',
              banType: 'SAFEGUARDING',
              effectiveFrom: '2026-01-01',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // MusterService
  // ───────────────────────────────────────────────────────────────────
  describe('MusterService', () => {
    async function seedOnSite(name = 'Mu'): Promise<string> {
      const dto = await withTestTenant(async () =>
        signIn.create(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: name,
            lastName: 'Ster',
            email: name.toLowerCase() + Math.random().toString(36).slice(2, 7) + '@x.local',
          } as any,
          adminActor(),
        ),
      );
      return dto.id;
    }

    it('create snapshots active sign-ins as muster_entries', async () => {
      await seedOnSite('A');
      await seedOnSite('B');
      const detail = await withTestTenant(async () =>
        muster.create({ drillType: 'FIRE_DRILL' } as any, adminActor()),
      );
      expect(detail.muster.totalOnSiteAtSnapshot).toBeGreaterThanOrEqual(2);
      expect(detail.entries.length).toBeGreaterThanOrEqual(2);
    });

    it('getActive returns currently-open muster or null', async () => {
      await seedOnSite();
      const created = await withTestTenant(async () =>
        muster.create({ drillType: 'EVACUATION' } as any, adminActor()),
      );
      const active = await withTestTenant(async () => muster.getActive());
      expect(active?.id).toBe(created.muster.id);
    });

    it('updateEntry marks SAFE + getSummary counts', async () => {
      await seedOnSite();
      const created = await withTestTenant(async () =>
        muster.create({ drillType: 'FIRE_DRILL' } as any, adminActor()),
      );
      const entry = created.entries[0]!;
      await withTestTenant(async () =>
        muster.updateEntry(entry.id, { status: 'ACCOUNTED_FOR' } as any, adminActor()),
      );
      const summary = await withTestTenant(async () => muster.getSummary(created.muster.id));
      expect(summary.accountedFor).toBeGreaterThanOrEqual(1);
    });

    it('close marks closed_at and getActive becomes null', async () => {
      const created = await withTestTenant(async () =>
        muster.create({ drillType: 'FIRE_DRILL' } as any, adminActor()),
      );
      await withTestTenant(async () => muster.close(created.muster.id, adminActor()));
      const active = await withTestTenant(async () => muster.getActive());
      expect(active).toBeNull();
    });

    it('list returns all musters for school', async () => {
      await withTestTenant(async () =>
        muster.create({ drillType: 'FIRE_DRILL' } as any, adminActor()),
      );
      const list = await withTestTenant(async () => muster.list());
      expect(list.length).toBeGreaterThan(0);
    });

    it('getDetail missing → 404', async () => {
      await expect(
        withTestTenant(async () => muster.getDetail('00000000-0000-0000-0000-000000000099')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // VisitorMusterConsumer
  // ───────────────────────────────────────────────────────────────────
  describe('VisitorMusterConsumer.handle', () => {
    it('materialises muster row from inc.emergency.muster.requested event', async () => {
      (consumer as any).idempotency = {
        isClaimed: async () => false,
        claim: async () => {},
      };
      const incidentId = generateId();
      const msg = {
        topic: 'inc.emergency.muster.requested',
        partition: 0,
        offset: '1',
        key: incidentId,
        payload: {
          event_id: generateId(),
          tenant_id: TEST_SCHOOL_ID,
          payload: {
            incidentId,
            schoolId: TEST_SCHOOL_ID,
            drillType: 'EVACUATION',
            totalOnSiteAtSnapshot: 5,
            createdBy: TEST_ADMIN_ACCOUNT_ID,
            declaredAt: new Date().toISOString(),
          },
        },
        headers: { 'tenant-subdomain': 'test' },
        timestamp: Date.now().toString(),
      } as any;
      await (consumer as any).handle(msg);
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.vis_emergency_muster WHERE incident_id = $1::uuid`,
        incidentId,
      );
      expect(rows.length).toBe(1);
    });

    it('duplicate delivery → ON CONFLICT DO NOTHING, no second row', async () => {
      (consumer as any).idempotency = {
        isClaimed: async () => false,
        claim: async () => {},
      };
      const incidentId = generateId();
      const buildMsg = () => ({
        topic: 'inc.emergency.muster.requested',
        partition: 0,
        offset: '1',
        key: incidentId,
        payload: {
          event_id: generateId(),
          tenant_id: TEST_SCHOOL_ID,
          payload: {
            incidentId,
            schoolId: TEST_SCHOOL_ID,
            drillType: 'EVACUATION',
            totalOnSiteAtSnapshot: 3,
            createdBy: TEST_ADMIN_ACCOUNT_ID,
            declaredAt: new Date().toISOString(),
          },
        },
        headers: { 'tenant-subdomain': 'test' },
        timestamp: Date.now().toString(),
      });
      await (consumer as any).handle(buildMsg() as any);
      await (consumer as any).handle(buildMsg() as any);
      const rows = await rawClient.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM ${TEST_SCHEMA}.vis_emergency_muster WHERE incident_id = $1::uuid`,
        incidentId,
      );
      expect(Number(rows[0]!.c)).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // VisitorsController (lightweight pass-through)
  // ───────────────────────────────────────────────────────────────────
  describe('VisitorsController (pass-through)', () => {
    const fakeReq = {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.local',
        displayName: 'Admin',
        sessionId: 's',
      },
    } as any;

    it('visitor types CRUD via controller', async () => {
      const list = await withTestTenant(async () => ctrl.listTypes(false as any, fakeReq));
      expect(list.length).toBeGreaterThan(0);
      const dto = await withTestTenant(async () =>
        ctrl.createType({ name: 'CtrlNew' } as any, fakeReq),
      );
      expect(dto.name).toBe('CtrlNew');
      const patched = await withTestTenant(async () =>
        ctrl.patchType(dto.id, { description: 'd' } as any, fakeReq),
      );
      expect(patched.description).toBe('d');
    });

    it('settings get + patch', async () => {
      const dto = await withTestTenant(async () => ctrl.getSettings());
      expect(dto.requirePurpose).toBeDefined();
      const upd = await withTestTenant(async () =>
        ctrl.patchSettings({ kioskWelcomeMessage: 'New' } as any, fakeReq),
      );
      expect(upd.kioskWelcomeMessage).toBe('New');
    });

    it('directory list + lookup', async () => {
      await withTestTenant(async () =>
        ctrl.createVisitor(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'Dr',
            lastName: 'Ec',
            email: 'dr@x.local',
          } as any,
          fakeReq,
        ),
      );
      const list = await withTestTenant(async () => ctrl.listVisitors(undefined as any, fakeReq));
      expect(list.length).toBeGreaterThan(0);
      const lookup = await withTestTenant(async () => ctrl.lookup({ email: 'dr@x.local' } as any));
      expect(lookup?.firstName).toBe('Dr');
    });

    it('sign-in/out/list paths', async () => {
      const dto = await withTestTenant(async () =>
        ctrl.createSignIn(
          {
            visitorTypeId: TEST_VIS_TYPE_PARENT_A_ID,
            firstName: 'CT',
            lastName: 'Sign',
            email: 'cts@x.local',
          } as any,
          fakeReq,
        ),
      );
      const onSite = await withTestTenant(async () => ctrl.listOnSite());
      expect(onSite.map((s) => s.id)).toContain(dto.id);
      const log = await withTestTenant(async () => ctrl.listLog({} as any));
      expect(log.map((s) => s.id)).toContain(dto.id);
      const get = await withTestTenant(async () => ctrl.getSignIn(dto.id));
      expect(get.id).toBe(dto.id);
      await withTestTenant(async () => ctrl.signOut(dto.id, fakeReq));
    });

    it('banned-person + check + muster paths', async () => {
      const dto = await withTestTenant(async () =>
        ctrl.createBanned(
          {
            firstName: 'B',
            lastName: 'P',
            banReason: 'r',
            banType: 'SAFEGUARDING',
            effectiveFrom: '2026-01-01',
          } as any,
          fakeReq,
        ),
      );
      const list = await withTestTenant(async () => ctrl.listBanned(false as any, fakeReq));
      expect(list.map((b) => b.id)).toContain(dto.id);
      const one = await withTestTenant(async () => ctrl.getBanned(dto.id, fakeReq));
      expect(one.id).toBe(dto.id);
      const patched = await withTestTenant(async () =>
        ctrl.patchBanned(dto.id, { notes: 'n' } as any, fakeReq),
      );
      expect(patched.notes).toBe('n');
      const checked = await withTestTenant(async () =>
        ctrl.checkBanned({ firstName: 'B', lastName: 'P' } as any, fakeReq),
      );
      expect(checked.blocked).toBe(true);

      // Muster (createMuster returns MusterDetailDto with .muster wrapper)
      const m = await withTestTenant(async () =>
        ctrl.createMuster({ drillType: 'FIRE_DRILL' } as any, fakeReq),
      );
      const mId = m.muster.id;
      const mList = await withTestTenant(async () => ctrl.listMusters());
      expect(mList.map((x: any) => x.id)).toContain(mId);
      const ma = await withTestTenant(async () => ctrl.getActiveMuster());
      expect(ma?.id).toBe(mId);
      const detail = await withTestTenant(async () => ctrl.getMuster(mId));
      expect(detail.muster.id).toBe(mId);
      const summary = await withTestTenant(async () => ctrl.getMusterSummary(mId));
      expect(summary.total).toBeDefined();
      await withTestTenant(async () => ctrl.closeMuster(mId, fakeReq));
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Fixture sanity
  // ───────────────────────────────────────────────────────────────────
  describe('fixture sanity', () => {
    it('reset wipes vis_*', async () => {
      await resetVisitorsTables(rawClient);
      const rows = await rawClient.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM ${TEST_SCHEMA}.vis_visitor_types`,
      );
      expect(Number(rows[0]!.c)).toBe(0);
    });
  });
});
