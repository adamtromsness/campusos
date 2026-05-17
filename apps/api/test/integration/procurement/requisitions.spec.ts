import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { RequisitionService } from '@modules/m86-procurement/requisitions.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { FinanceValidationService } from '@modules/m83-finance/validation';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { withTestTenant, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { resetProcurementTables } from '../helpers/reset';
import { RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_OFFICER_PERSON_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  TEST_BUDGET_LINE_ID,
  TEST_SUPPLIER_A_ID,
  TEST_SUPPLIER_B_ID,
  TEST_INACTIVE_SUPPLIER_ID,
} from '../fixtures/finance';
import type {
  CreateRequisitionDto,
  CreateRequisitionLineDto,
} from '@modules/m86-procurement/dto/procurement.dto';

/**
 * Loop 3 — DATABASE-BACKED integration tests for RequisitionService.
 *
 * Covers list / getById / create / addLine / removeLine / submit / approve /
 * reject / markOrdered. Every test:
 *
 *   - calls a real RequisitionService instantiated with real TenantPrismaService
 *     against tenant_test;
 *   - asserts on real DB state via raw SQL OR on the returned DTO that the
 *     service built from a real SELECT after the write;
 *   - exercises both happy paths and error branches (auth gate, status guard,
 *     budget overflow, FK validation, illegal transition).
 *
 * Kafka emits are captured by RecordingKafkaProducer so the submit() payload
 * shape can be asserted without a live broker.
 *
 * Per the design doc: shared fixtures (school, employees, suppliers, budget)
 * are seeded once by globalSetup and survive across tests. Procurement
 * tables are TRUNCATEd in beforeEach via resetProcurementTables.
 */

const VALID_LINE_TECH: CreateRequisitionLineDto = {
  itemDescription: 'Chromebook 14"',
  quantity: 10,
  unit: 'each',
  estimatedUnitCost: 250,
  destinationModule: 'tech',
};

const VALID_LINE_FDS: CreateRequisitionLineDto = {
  itemDescription: 'Cafeteria napkins (case)',
  quantity: 20,
  unit: 'case',
  estimatedUnitCost: 15.5,
  destinationModule: 'fds',
};

function buildCreateInput(overrides?: Partial<CreateRequisitionDto>): CreateRequisitionDto {
  return {
    requestingDepartment: 'Tech',
    urgency: 'ROUTINE',
    justification: 'Replacement laptops for grade 5 classroom',
    lines: [VALID_LINE_TECH],
    ...overrides,
  };
}

describe('integration:RequisitionService', () => {
  let tenantPrisma: TenantPrismaService;
  let finance: FinanceValidationService;
  let kafka: RecordingKafkaProducer;
  let service: RequisitionService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    finance = new FinanceValidationService(tenantPrisma);
    kafka = new RecordingKafkaProducer();
    service = new RequisitionService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      finance,
    );
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    kafka.reset();
    await withTestTenant(async () => {
      await resetProcurementTables(tenantPrisma);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // create
  // ──────────────────────────────────────────────────────────────
  describe('create', () => {
    it('happy path inserts requisition + lines with computed total', async () => {
      const result = await withTestTenant(async () =>
        service.create(officerActor(), {
          requestingDepartment: 'Tech',
          urgency: 'URGENT',
          justification: '2-line order across tech and food service',
          budgetLineId: TEST_BUDGET_LINE_ID,
          lines: [VALID_LINE_TECH, VALID_LINE_FDS],
        }),
      );

      // Total = 10 * 250 + 20 * 15.5 = 2810
      expect(result.totalEstimatedCost).toBe(2810);
      expect(result.status).toBe('DRAFT');
      expect(result.urgency).toBe('URGENT');
      expect(result.requestingDepartment).toBe('Tech');
      expect(result.budgetLineId).toBe(TEST_BUDGET_LINE_ID);
      expect(result.requestingPersonId).toBe(TEST_OFFICER_PERSON_ID);
      expect(result.lines).toHaveLength(2);
      expect(result.lines[0]!.itemDescription).toBe('Chromebook 14"');
      expect(result.lines[0]!.lineOrder).toBe(0);
      expect(result.lines[1]!.itemDescription).toBe('Cafeteria napkins (case)');
      expect(result.lines[1]!.lineOrder).toBe(1);

      // DB-state assertion via raw SQL
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, status, total_estimated_cost,
                (SELECT count(*)::int FROM tenant_test.prc_requisition_lines
                 WHERE requisition_id = $1::uuid) AS line_count
         FROM tenant_test.prc_requisitions WHERE id = $1::uuid`,
        result.id,
      )) as Array<{ id: string; status: string; total_estimated_cost: string; line_count: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('DRAFT');
      expect(Number(rows[0]!.total_estimated_cost)).toBe(2810);
      expect(Number(rows[0]!.line_count)).toBe(2);
    });

    it('defaults urgency to ROUTINE when not supplied', async () => {
      const result = await withTestTenant(async () =>
        service.create(officerActor(), {
          justification: 'minimal request',
          lines: [VALID_LINE_TECH],
        }),
      );
      expect(result.urgency).toBe('ROUTINE');
    });

    it('rejects an invalid budgetLineId from FinanceValidationService', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), {
            justification: 'bogus budget ref',
            budgetLineId: '00000000-0000-0000-0000-000000000999',
            lines: [VALID_LINE_TECH],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Nothing was inserted
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM tenant_test.prc_requisitions`,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    });

    it('rejects an invalid preferredVendorId on a line', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), {
            justification: 'bogus vendor ref',
            lines: [
              {
                ...VALID_LINE_TECH,
                preferredVendorId: '00000000-0000-0000-0000-000000000999',
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an inactive supplier as preferredVendorId', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), {
            justification: 'inactive vendor',
            lines: [
              {
                ...VALID_LINE_TECH,
                preferredVendorId: TEST_INACTIVE_SUPPLIER_ID,
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts an active supplier as preferredVendorId and stores it on the line', async () => {
      const result = await withTestTenant(async () =>
        service.create(officerActor(), {
          justification: 'with vendor preference',
          lines: [{ ...VALID_LINE_TECH, preferredVendorId: TEST_SUPPLIER_A_ID }],
        }),
      );
      expect(result.lines[0]!.preferredVendorId).toBe(TEST_SUPPLIER_A_ID);
      expect(result.lines[0]!.preferredVendorName).toBe('Test Vendor Alpha');
    });

    it('stamps requesting_person_id from actor.personId, not from input', async () => {
      const result = await withTestTenant(async () =>
        service.create(teacherActor(), buildCreateInput()),
      );
      expect(result.requestingPersonId).toBe(TEST_TEACHER_PERSON_ID);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // list + getById row scope
  // ──────────────────────────────────────────────────────────────
  describe('list / getById row scope', () => {
    async function seedTwoReqs(): Promise<{ officerReqId: string; studentReqId: string }> {
      const officer = await withTestTenant(async () =>
        service.create(officerActor(), buildCreateInput({ justification: 'officer req' })),
      );
      const student = await withTestTenant(async () =>
        service.create(studentActor(), buildCreateInput({ justification: 'student req' })),
      );
      return { officerReqId: officer.id, studentReqId: student.id };
    }

    it('admin sees all requisitions', async () => {
      const { officerReqId, studentReqId } = await seedTwoReqs();
      const rows = await withTestTenant(async () => service.list(adminActor()));
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(officerReqId);
      expect(ids).toContain(studentReqId);
    });

    it('procurement officer (STAFF, non-admin) sees all requisitions', async () => {
      await seedTwoReqs();
      const rows = await withTestTenant(async () => service.list(officerActor()));
      expect(rows).toHaveLength(2);
    });

    it('student sees only own requisition', async () => {
      const { studentReqId } = await seedTwoReqs();
      const rows = await withTestTenant(async () => service.list(studentActor()));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(studentReqId);
      expect(rows[0]!.requestingPersonId).toBe(TEST_STUDENT_PERSON_ID);
    });

    it('parent sees only own requisitions (none here)', async () => {
      await seedTwoReqs();
      const rows = await withTestTenant(async () => service.list(parentActor()));
      expect(rows).toHaveLength(0);
    });

    it('optional status filter narrows the result set', async () => {
      const { officerReqId } = await seedTwoReqs();
      // Default status on create is DRAFT
      const drafts = await withTestTenant(async () => service.list(adminActor(), 'DRAFT'));
      expect(drafts.map((r) => r.id)).toContain(officerReqId);
      const submitted = await withTestTenant(async () => service.list(adminActor(), 'SUBMITTED'));
      expect(submitted).toHaveLength(0);
    });

    it('getById returns own requisition for student', async () => {
      const { studentReqId } = await seedTwoReqs();
      const r = await withTestTenant(async () => service.getById(studentReqId, studentActor()));
      expect(r.id).toBe(studentReqId);
    });

    it("getById 404s a non-officer non-owner with collapsed don't-leak-existence", async () => {
      const { officerReqId } = await seedTwoReqs();
      await expect(
        withTestTenant(async () => service.getById(officerReqId, studentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById admin can read any row', async () => {
      const { studentReqId } = await seedTwoReqs();
      const r = await withTestTenant(async () => service.getById(studentReqId, adminActor()));
      expect(r.id).toBe(studentReqId);
    });

    it('getById bogus id throws NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getById('00000000-0000-0000-0000-000000000999', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // addLine + removeLine
  // ──────────────────────────────────────────────────────────────
  describe('addLine + removeLine', () => {
    async function seedDraft(): Promise<string> {
      const r = await withTestTenant(async () =>
        service.create(officerActor(), buildCreateInput()),
      );
      return r.id;
    }

    it('owner adds a line and total recomputes', async () => {
      const reqId = await seedDraft();
      const updated = await withTestTenant(async () =>
        service.addLine(officerActor(), reqId, VALID_LINE_FDS),
      );
      expect(updated.lines).toHaveLength(2);
      expect(updated.totalEstimatedCost).toBe(10 * 250 + 20 * 15.5);
      expect(updated.lines[1]!.lineOrder).toBe(1);
    });

    it('admin can add a line on behalf of the owner', async () => {
      const reqId = await seedDraft();
      const updated = await withTestTenant(async () =>
        service.addLine(adminActor(), reqId, VALID_LINE_FDS),
      );
      expect(updated.lines).toHaveLength(2);
    });

    it('non-owner non-admin gets ForbiddenException', async () => {
      const reqId = await seedDraft();
      await expect(
        withTestTenant(async () => service.addLine(teacherActor(), reqId, VALID_LINE_FDS)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('addLine refuses non-DRAFT requisitions', async () => {
      const reqId = await seedDraft();
      // Move to SUBMITTED
      await withTestTenant(async () => service.submit(officerActor(), reqId));
      await expect(
        withTestTenant(async () => service.addLine(officerActor(), reqId, VALID_LINE_FDS)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addLine bogus reqId throws NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.addLine(adminActor(), '00000000-0000-0000-0000-000000000999', VALID_LINE_FDS),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('addLine validates preferredVendorId', async () => {
      const reqId = await seedDraft();
      await expect(
        withTestTenant(async () =>
          service.addLine(officerActor(), reqId, {
            ...VALID_LINE_FDS,
            preferredVendorId: TEST_INACTIVE_SUPPLIER_ID,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('owner removes a line and total recomputes', async () => {
      const created = await withTestTenant(async () =>
        service.create(officerActor(), {
          justification: 'two-line req for remove test',
          lines: [VALID_LINE_TECH, VALID_LINE_FDS],
        }),
      );
      const lineToRemove = created.lines[1]!;
      await withTestTenant(async () => service.removeLine(officerActor(), lineToRemove.id));

      const after = await withTestTenant(async () => service.getById(created.id, officerActor()));
      expect(after.lines).toHaveLength(1);
      expect(after.totalEstimatedCost).toBe(10 * 250);
    });

    it('removeLine non-owner non-admin → 403', async () => {
      const created = await withTestTenant(async () =>
        service.create(officerActor(), {
          justification: 'two-line for remove auth',
          lines: [VALID_LINE_TECH, VALID_LINE_FDS],
        }),
      );
      await expect(
        withTestTenant(async () => service.removeLine(teacherActor(), created.lines[1]!.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('removeLine refuses non-DRAFT', async () => {
      const created = await withTestTenant(async () =>
        service.create(officerActor(), {
          justification: 'will be submitted',
          lines: [VALID_LINE_TECH, VALID_LINE_FDS],
        }),
      );
      await withTestTenant(async () => service.submit(officerActor(), created.id));
      await expect(
        withTestTenant(async () => service.removeLine(officerActor(), created.lines[1]!.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('removeLine bogus lineId throws NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.removeLine(adminActor(), '00000000-0000-0000-0000-000000000999'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // submit
  // ──────────────────────────────────────────────────────────────
  describe('submit', () => {
    async function seedDraftWithBudget(): Promise<string> {
      const r = await withTestTenant(async () =>
        service.create(officerActor(), {
          ...buildCreateInput(),
          budgetLineId: TEST_BUDGET_LINE_ID,
        }),
      );
      return r.id;
    }

    it('flips status to SUBMITTED + stamps submitted_at + emits Kafka envelope', async () => {
      const reqId = await seedDraftWithBudget();
      const result = await withTestTenant(async () => service.submit(officerActor(), reqId));

      expect(result.status).toBe('SUBMITTED');
      expect(result.submittedAt).not.toBeNull();

      // DB-state
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, submitted_at::text AS submitted_at
         FROM tenant_test.prc_requisitions WHERE id = $1::uuid`,
        reqId,
      )) as Array<{ status: string; submitted_at: string | null }>;
      expect(rows[0]!.status).toBe('SUBMITTED');
      expect(rows[0]!.submitted_at).not.toBeNull();

      // Kafka emit
      const emitted = kafka.callsForTopic('prc.requisition.submitted');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.sourceModule).toBe('procurement');
      expect(emitted[0]!.key).toBe(reqId);
      expect(emitted[0]!.payload).toMatchObject({
        requisitionId: reqId,
        sourceRefId: reqId,
        schoolId: TEST_SCHOOL_ID,
        requestingPersonId: TEST_OFFICER_PERSON_ID,
        urgency: 'ROUTINE',
        budgetLineId: TEST_BUDGET_LINE_ID,
        totalEstimatedCost: 10 * 250,
      });
    });

    it('refuses non-DRAFT submit', async () => {
      const reqId = await seedDraftWithBudget();
      await withTestTenant(async () => service.submit(officerActor(), reqId));
      await expect(
        withTestTenant(async () => service.submit(officerActor(), reqId)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects empty-lines requisition', async () => {
      // Create then remove the only line so submit sees zero lines
      const created = await withTestTenant(async () =>
        service.create(officerActor(), buildCreateInput()),
      );
      await withTestTenant(async () => service.removeLine(officerActor(), created.lines[0]!.id));
      await expect(
        withTestTenant(async () => service.submit(officerActor(), created.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-owner non-admin cannot submit', async () => {
      const reqId = await seedDraftWithBudget();
      await expect(
        withTestTenant(async () => service.submit(teacherActor(), reqId)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("admin can submit any owner's requisition", async () => {
      const reqId = await seedDraftWithBudget();
      const result = await withTestTenant(async () => service.submit(adminActor(), reqId));
      expect(result.status).toBe('SUBMITTED');
    });

    it('rejects when total exceeds remaining budget', async () => {
      // Create a requisition whose total > $10,000 budget
      const big = await withTestTenant(async () =>
        service.create(officerActor(), {
          justification: 'over-budget request',
          budgetLineId: TEST_BUDGET_LINE_ID,
          lines: [
            {
              itemDescription: 'Expensive item',
              quantity: 100,
              estimatedUnitCost: 1000, // 100 * 1000 = $100,000 > $10,000 budget
              destinationModule: 'tech',
            },
          ],
        }),
      );

      await expect(
        withTestTenant(async () => service.submit(officerActor(), big.id)),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Confirm no Kafka emit
      expect(kafka.callsForTopic('prc.requisition.submitted')).toHaveLength(0);

      // Confirm status stayed DRAFT
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM tenant_test.prc_requisitions WHERE id = $1::uuid`,
        big.id,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('DRAFT');
    });

    it('without budgetLineId, skips the budget check and submits', async () => {
      const created = await withTestTenant(async () =>
        service.create(officerActor(), {
          justification: 'no budget line',
          lines: [VALID_LINE_TECH], // $2,500 — well under $10,000 even if checked
        }),
      );
      const result = await withTestTenant(async () => service.submit(officerActor(), created.id));
      expect(result.status).toBe('SUBMITTED');
      expect(result.budgetLineId).toBeNull();
    });

    it('bogus reqId throws NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.submit(adminActor(), '00000000-0000-0000-0000-000000000999'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // approve
  // ──────────────────────────────────────────────────────────────
  describe('approve', () => {
    async function seedSubmitted(): Promise<string> {
      const r = await withTestTenant(async () =>
        service.create(officerActor(), buildCreateInput()),
      );
      await withTestTenant(async () => service.submit(officerActor(), r.id));
      return r.id;
    }

    it('SUBMITTED → DEPT_APPROVED happy path stamps reviewer + reviewed_at', async () => {
      const reqId = await seedSubmitted();
      const result = await withTestTenant(async () =>
        service.approve(adminActor(), reqId, { toStatus: 'DEPT_APPROVED' }),
      );

      expect(result.status).toBe('DEPT_APPROVED');
      expect(result.reviewedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(result.reviewedAt).not.toBeNull();

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, reviewed_by::text AS reviewed_by, reviewed_at IS NOT NULL AS has_at
         FROM tenant_test.prc_requisitions WHERE id = $1::uuid`,
        reqId,
      )) as Array<{ status: string; reviewed_by: string; has_at: boolean }>;
      expect(rows[0]!.status).toBe('DEPT_APPROVED');
      expect(rows[0]!.reviewed_by).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(rows[0]!.has_at).toBe(true);
    });

    it('full transition chain: SUBMITTED → DEPT → ADMIN → DISTRICT', async () => {
      const reqId = await seedSubmitted();
      await withTestTenant(async () =>
        service.approve(adminActor(), reqId, { toStatus: 'DEPT_APPROVED' }),
      );
      await withTestTenant(async () =>
        service.approve(adminActor(), reqId, { toStatus: 'ADMIN_APPROVED' }),
      );
      const final = await withTestTenant(async () =>
        service.approve(adminActor(), reqId, { toStatus: 'DISTRICT_APPROVED' }),
      );
      expect(final.status).toBe('DISTRICT_APPROVED');
    });

    it('rejects illegal transition SUBMITTED → ADMIN_APPROVED (must go via DEPT)', async () => {
      const reqId = await seedSubmitted();
      await expect(
        withTestTenant(async () =>
          service.approve(adminActor(), reqId, { toStatus: 'ADMIN_APPROVED' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects approve on a DRAFT (no transitions allowed from DRAFT)', async () => {
      const draft = await withTestTenant(async () =>
        service.create(officerActor(), buildCreateInput()),
      );
      await expect(
        withTestTenant(async () =>
          service.approve(adminActor(), draft.id, { toStatus: 'DEPT_APPROVED' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin cannot approve', async () => {
      const reqId = await seedSubmitted();
      await expect(
        withTestTenant(async () =>
          service.approve(officerActor(), reqId, { toStatus: 'DEPT_APPROVED' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('bogus reqId throws NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.approve(adminActor(), '00000000-0000-0000-0000-000000000999', {
            toStatus: 'DEPT_APPROVED',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin without employeeId throws BadRequestException', async () => {
      const reqId = await seedSubmitted();
      const adminNoEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () =>
          service.approve(adminNoEmp, reqId, { toStatus: 'DEPT_APPROVED' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // reject
  // ──────────────────────────────────────────────────────────────
  describe('reject', () => {
    async function seedSubmitted(): Promise<string> {
      const r = await withTestTenant(async () =>
        service.create(officerActor(), buildCreateInput()),
      );
      await withTestTenant(async () => service.submit(officerActor(), r.id));
      return r.id;
    }

    it('SUBMITTED → REJECTED with reason stamped', async () => {
      const reqId = await seedSubmitted();
      const result = await withTestTenant(async () =>
        service.reject(adminActor(), reqId, { reason: 'Out of scope for this quarter' }),
      );

      expect(result.status).toBe('REJECTED');
      expect(result.rejectionReason).toBe('Out of scope for this quarter');
      expect(result.reviewedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, rejection_reason FROM tenant_test.prc_requisitions WHERE id = $1::uuid`,
        reqId,
      )) as Array<{ status: string; rejection_reason: string }>;
      expect(rows[0]!.status).toBe('REJECTED');
      expect(rows[0]!.rejection_reason).toBe('Out of scope for this quarter');
    });

    it('non-admin cannot reject', async () => {
      const reqId = await seedSubmitted();
      await expect(
        withTestTenant(async () => service.reject(officerActor(), reqId, { reason: 'denied' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejecting a REJECTED requisition throws BadRequestException', async () => {
      const reqId = await seedSubmitted();
      await withTestTenant(async () => service.reject(adminActor(), reqId, { reason: 'first' }));
      await expect(
        withTestTenant(async () => service.reject(adminActor(), reqId, { reason: 'again' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bogus reqId throws NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.reject(adminActor(), '00000000-0000-0000-0000-000000000999', {
            reason: 'whatever',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin without employeeId throws BadRequestException', async () => {
      const reqId = await seedSubmitted();
      const adminNoEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () => service.reject(adminNoEmp, reqId, { reason: 'no emp' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // markOrdered (helper used by PO service)
  // ──────────────────────────────────────────────────────────────
  describe('markOrdered', () => {
    it('ADMIN_APPROVED → ORDERED', async () => {
      const created = await withTestTenant(async () =>
        service.create(officerActor(), buildCreateInput()),
      );
      await withTestTenant(async () => service.submit(officerActor(), created.id));
      await withTestTenant(async () =>
        service.approve(adminActor(), created.id, { toStatus: 'DEPT_APPROVED' }),
      );
      await withTestTenant(async () =>
        service.approve(adminActor(), created.id, { toStatus: 'ADMIN_APPROVED' }),
      );

      await withTestTenant(async () => service.markOrdered(adminActor(), created.id));

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM tenant_test.prc_requisitions WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('ORDERED');
    });

    it('SUBMITTED stays SUBMITTED (status filter is the safety net)', async () => {
      const created = await withTestTenant(async () =>
        service.create(officerActor(), buildCreateInput()),
      );
      await withTestTenant(async () => service.submit(officerActor(), created.id));

      // Try to markOrdered while still SUBMITTED — silent no-op
      await withTestTenant(async () => service.markOrdered(adminActor(), created.id));

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM tenant_test.prc_requisitions WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('SUBMITTED');
    });
  });

  // sanity: unused symbols guard — touching exports we depend on so a
  // refactor that removes them surfaces here.
  it('imports remain wired (sanity)', () => {
    expect(TEST_PARENT_PERSON_ID).toBeTruthy();
    expect(TEST_SUPPLIER_B_ID).toBeTruthy();
  });
});
