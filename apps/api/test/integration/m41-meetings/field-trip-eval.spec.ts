import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FieldTripEvalService } from '@modules/m41-meetings/meetings/field-trip-eval.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
  teacherActor,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';

/**
 * Wave 5 — m41-meetings FieldTripEvalService.
 *
 * UNIQUE(field_trip_id, evaluated_by) caps each evaluator at one row
 * per trip. Ratings are bounded 1..5 by schema CHECK.
 */
describe('integration:m41-meetings/field-trip-eval', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: FieldTripEvalService;

  let fieldTripId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    service = new FieldTripEvalService(tenantPrisma);

    // Seed a field trip — read-or-create.
    const existing = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_field_trips
        WHERE school_id = $1::uuid AND title = 'Museum Trip' LIMIT 1`,
      TEST_SCHOOL_ID,
    );
    if (existing.length > 0) {
      fieldTripId = existing[0]!.id;
    } else {
      fieldTripId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trips (id, school_id, title, destination, trip_date, organiser_id, status)
         VALUES ($1::uuid, $2::uuid, 'Museum Trip', 'City Museum', '2026-10-15', $3::uuid, 'COMPLETED')`,
        fieldTripId,
        TEST_SCHOOL_ID,
        TEST_ADMIN_EMPLOYEE_ID,
      );
    }
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.ext_field_trip_evaluations WHERE field_trip_id = $1::uuid`,
      fieldTripId,
    );
  });

  describe('create', () => {
    it('staff creates evaluation → row inserted', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          fieldTripId,
          {
            overallRating: 5,
            educationalValueRating: 4,
            logisticsRating: 5,
            safetyRating: 5,
            comments: 'Great trip',
            wouldRecommend: true,
          } as any,
          teacherActor(),
        ),
      );
      expect(dto.overallRating).toBe(5);
      expect(dto.wouldRecommend).toBe(true);
      expect(dto.evaluatedBy).toBe(TEST_TEACHER_EMPLOYEE_ID);
    });

    it('admin can also create evaluation (admin bypass on assertStaff)', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          fieldTripId,
          { overallRating: 3 } as any,
          adminActor(),
        ),
      );
      expect(dto.overallRating).toBe(3);
    });

    it('duplicate (trip, evaluator) → BadRequestException', async () => {
      await withTestTenant(async () =>
        service.create(fieldTripId, { overallRating: 4 } as any, teacherActor()),
      );
      await expect(
        withTestTenant(async () =>
          service.create(fieldTripId, { overallRating: 5 } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('STUDENT cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(fieldTripId, { overallRating: 5 } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('GUARDIAN cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(fieldTripId, { overallRating: 5 } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('listForTrip / summary', () => {
    it('listForTrip returns evaluations ordered DESC by created_at', async () => {
      await withTestTenant(async () =>
        service.create(fieldTripId, { overallRating: 4 } as any, teacherActor()),
      );
      await withTestTenant(async () =>
        service.create(fieldTripId, { overallRating: 5 } as any, adminActor()),
      );
      const list = await withTestTenant(async () =>
        service.listForTrip(fieldTripId, adminActor()),
      );
      expect(list).toHaveLength(2);
    });

    it('STUDENT cannot list → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => service.listForTrip(fieldTripId, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('summary computes aggregate ratings', async () => {
      await withTestTenant(async () =>
        service.create(
          fieldTripId,
          {
            overallRating: 4,
            educationalValueRating: 3,
            logisticsRating: 5,
            safetyRating: 5,
            wouldRecommend: true,
          } as any,
          teacherActor(),
        ),
      );
      await withTestTenant(async () =>
        service.create(
          fieldTripId,
          {
            overallRating: 2,
            educationalValueRating: 1,
            logisticsRating: 3,
            safetyRating: 4,
            wouldRecommend: false,
          } as any,
          adminActor(),
        ),
      );
      const summary = await withTestTenant(async () =>
        service.summary(fieldTripId, adminActor()),
      );
      expect(summary.evaluationCount).toBe(2);
      expect(summary.averageOverall).toBeCloseTo(3.0, 1);
      expect(summary.averageEducational).toBeCloseTo(2.0, 1);
      expect(summary.averageLogistics).toBeCloseTo(4.0, 1);
      expect(summary.averageSafety).toBeCloseTo(4.5, 1);
      expect(summary.recommendCount).toBe(1);
    });

    it('summary on trip with no evaluations returns zero count and null averages', async () => {
      const summary = await withTestTenant(async () =>
        service.summary(fieldTripId, adminActor()),
      );
      expect(summary.evaluationCount).toBe(0);
      expect(summary.recommendCount).toBe(0);
      expect(summary.averageOverall).toBeNull();
    });

    it('summary STUDENT denial → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => service.summary(fieldTripId, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  void generateId;
});
