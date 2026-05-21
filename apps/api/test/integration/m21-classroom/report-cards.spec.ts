import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ReportCardSubjectService } from '@modules/m21-classroom/report-cards/report-card-subject.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, teacherActor, TEST_TEACHER_EMPLOYEE_ID } from '../helpers/actor';
import { TEST_SIS_CLASS_ID, TEST_SIS_COURSE_ID, TEST_SIS_TERM_ID } from '../fixtures/sis';
import { seedStudent, assignTeacherToClass, cleanupSeededIds } from '../m20-sis/sis-helpers';

describe('integration:m21-classroom/report-cards', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: ReportCardSubjectService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const reportCardIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    service = new ReportCardSubjectService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    if (reportCardIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_report_card_subjects WHERE report_card_id = ANY($1::uuid[])`,
        reportCardIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_report_cards WHERE id = ANY($1::uuid[])`,
        reportCardIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      personIds: personIds.splice(0),
    });
  });

  async function trackedStudent() {
    const s = await seedStudent(rawClient);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function seedReportCard(studentId: string): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_report_cards (id, student_id, class_id, term_id, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DRAFT')`,
      id,
      studentId,
      TEST_SIS_CLASS_ID,
      TEST_SIS_TERM_ID,
    );
    reportCardIds.push(id);
    return id;
  }

  it('admin creates a report card subject', async () => {
    const s = await trackedStudent();
    const rcId = await seedReportCard(s.studentId);
    const subj = await withTestTenant(async () =>
      service.create(
        rcId,
        {
          subjectLabel: 'Math',
          courseId: TEST_SIS_COURSE_ID,
          finalGrade: 'A',
          gradeValue: 95,
          teacherComments: 'Excellent',
          effortGrade: 'High',
          sortOrder: 1,
        } as any,
        adminActor(),
      ),
    );
    expect(subj.subjectLabel).toBe('Math');
    expect(subj.gradeValue).toBe(95);
    expect(subj.reportCardId).toBe(rcId);
  });

  it('class teacher can create a subject', async () => {
    await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
    const s = await trackedStudent();
    const rcId = await seedReportCard(s.studentId);
    const subj = await withTestTenant(async () =>
      service.create(rcId, { subjectLabel: 'Physics' } as any, teacherActor()),
    );
    expect(subj.subjectLabel).toBe('Physics');
  });

  it('non-class teacher → ForbiddenException', async () => {
    const s = await trackedStudent();
    const rcId = await seedReportCard(s.studentId);
    await expect(
      withTestTenant(async () =>
        service.create(rcId, { subjectLabel: 'X' } as any, teacherActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('unknown reportCardId → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        service.create(
          '00000000-0000-0000-0000-000000000000',
          { subjectLabel: 'X' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listForReportCard returns sorted subjects', async () => {
    const s = await trackedStudent();
    const rcId = await seedReportCard(s.studentId);
    await withTestTenant(async () =>
      service.create(rcId, { subjectLabel: 'B', sortOrder: 2 } as any, adminActor()),
    );
    await withTestTenant(async () =>
      service.create(rcId, { subjectLabel: 'A', sortOrder: 1 } as any, adminActor()),
    );
    const list = await withTestTenant(async () => service.listForReportCard(rcId));
    expect(list).toHaveLength(2);
    expect(list[0]!.subjectLabel).toBe('A');
    expect(list[1]!.subjectLabel).toBe('B');
  });

  it('getById returns the subject', async () => {
    const s = await trackedStudent();
    const rcId = await seedReportCard(s.studentId);
    const subj = await withTestTenant(async () =>
      service.create(rcId, { subjectLabel: 'Chem' } as any, adminActor()),
    );
    const fetched = await withTestTenant(async () => service.getById(subj.id));
    expect(fetched.id).toBe(subj.id);
  });

  it('getById unknown → NotFoundException', async () => {
    await expect(
      withTestTenant(async () => service.getById('00000000-0000-0000-0000-000000000000')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update changes fields', async () => {
    const s = await trackedStudent();
    const rcId = await seedReportCard(s.studentId);
    const subj = await withTestTenant(async () =>
      service.create(rcId, { subjectLabel: 'Old' } as any, adminActor()),
    );
    const updated = await withTestTenant(async () =>
      service.update(
        subj.id,
        { subjectLabel: 'New', finalGrade: 'B', gradeValue: 85 } as any,
        adminActor(),
      ),
    );
    expect(updated.subjectLabel).toBe('New');
    expect(updated.finalGrade).toBe('B');
    expect(updated.gradeValue).toBe(85);
  });

  it('update unknown id → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        service.update(
          '00000000-0000-0000-0000-000000000000',
          { subjectLabel: 'x' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update by non-class teacher → ForbiddenException', async () => {
    const s = await trackedStudent();
    const rcId = await seedReportCard(s.studentId);
    const subj = await withTestTenant(async () =>
      service.create(rcId, { subjectLabel: 'X' } as any, adminActor()),
    );
    await expect(
      withTestTenant(async () =>
        service.update(subj.id, { subjectLabel: 'Y' } as any, teacherActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('delete removes the subject', async () => {
    const s = await trackedStudent();
    const rcId = await seedReportCard(s.studentId);
    const subj = await withTestTenant(async () =>
      service.create(rcId, { subjectLabel: 'D' } as any, adminActor()),
    );
    await withTestTenant(async () => service.delete(subj.id, adminActor()));
    await expect(withTestTenant(async () => service.getById(subj.id))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('delete unknown id → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        service.delete('00000000-0000-0000-0000-000000000000', adminActor()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
