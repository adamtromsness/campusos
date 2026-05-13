import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '../../tenant/tenant.context';
import { ClassSetService } from '../class-set.service';
import { RecommendationService } from '../recommendation.service';
import { InterlibraryLoanService } from '../interlibrary-loan.service';
import { CatalogueImportService } from '../catalogue-import.service';
import { ReadingListService } from '../reading-list.service';

/**
 * REVIEW-P2C25 ROUND 1 — regression tests for the 6 BLOCKING school
 * -scope tightenings the reviewer flagged.
 *
 * Each describe block pins the SQL shape of one fix so the contract
 * cannot regress in a future cycle:
 *
 *   R-B1 — class-set getById / returnCopies lock / sweep school-scope
 *   R-B2 — class-set teacher + classId validation school-scope
 *   R-B3 — recommendations cross-school hardening
 *   R-B4 — reading-list item mutation paths school-scope
 *   R-B5 — ILL patch + sweep + LENT catalogue validation
 *   R-B6 — catalogue import markTerminal + intermediate updates school-scope
 */

const SCHOOL = {
  schoolId: '019eaaaa-0000-7556-8c81-aaaaaaaaaaaa',
  schemaName: 'tenant_demo',
  organisationId: null,
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'SMALL',
  homeRegion: 'us-east-1',
} as const;

const ADMIN_ACTOR = {
  accountId: 'admin-account',
  personId: 'admin-person',
  employeeId: 'admin-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
};

const TEACHER_ACTOR = {
  accountId: 'teacher-account',
  personId: 'teacher-person',
  employeeId: 'teacher-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};

const STUDENT_ACTOR = {
  accountId: 'student-account',
  personId: 'student-person',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
};

const PARENT_ACTOR = {
  accountId: 'parent-account',
  personId: 'parent-person',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
};

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeOutbox() {
  const emitted: Array<Record<string, unknown>> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: Record<string, unknown>) => {
      emitted.push({ ...opts });
    },
  };
  return { outbox, emitted };
}

function makePermCheck(resolver: (accountId: string, codes: string[]) => boolean = () => false) {
  return {
    hasAnyPermissionInTenant: async (accountId: string, _schoolId: string, codes: string[]) =>
      resolver(accountId, codes),
  } as never;
}

function withTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, async () => fn()) as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────
// R-B1 — Class-set getById / returnCopies lock / sweep school-scope
// ─────────────────────────────────────────────────────────────────

describe('REVIEW-P2C25 R-B1 — class-set school-scope', () => {
  it('getById SELECT carries cs.school_id predicate', async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(withTenant(() => svc.getById('cs-foreign'))).rejects.toThrow(NotFoundException);
    const selectSql = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.includes('FROM lib_class_set_checkouts cs'),
    )!;
    expect(selectSql).toBeDefined();
    expect(selectSql.sql).toMatch(
      /WHERE\s+cs\.id\s*=\s*\$1::uuid\s+AND\s+cs\.school_id\s*=\s*\$2::uuid/,
    );
    expect(selectSql.args[1]).toBe(SCHOOL.schoolId);
  });

  it('returnCopies parent lock JOINs by id AND school_id', async () => {
    let lockSql = '';
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM lib_class_set_checkouts WHERE') &&
        call.sql.includes('FOR UPDATE')
      ) {
        lockSql = call.sql;
        return []; // foreign-school cross-tenant lookup → 0 rows
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.returnCopies('cs-foreign', { copiesReturned: 1 }, ADMIN_ACTOR)),
    ).rejects.toThrow(NotFoundException);
    expect(lockSql).toMatch(
      /WHERE\s+id\s*=\s*\$1::uuid\s+AND\s+school_id\s*=\s*\$2::uuid\s+FOR UPDATE/,
    );
  });

  it('sweepOverdueForCurrentTenant binds to school_id', async () => {
    let sweepSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE lib_class_set_checkouts')) {
        sweepSql = call.sql;
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await withTenant(() => svc.sweepOverdueForCurrentTenant());
    expect(sweepSql).toMatch(/WHERE\s+school_id\s*=\s*\$1::uuid/);
    expect(sweepSql).toMatch(/ACTIVE/);
    expect(sweepSql).toMatch(/PARTIALLY_RETURNED/);
  });
});

// ─────────────────────────────────────────────────────────────────
// R-B2 — Class-set teacher + classId validation school-scope
// ─────────────────────────────────────────────────────────────────

describe('REVIEW-P2C25 R-B2 — class-set teacher + classId school-scope', () => {
  it('hr_employees probe carries school_id arg', async () => {
    let teacherSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_catalogue_items')) return [{ ok: 1 }];
      if (call.sql.includes('FROM hr_employees')) {
        teacherSql = call.sql;
        return []; // foreign-school teacher → 0 rows
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(
          {
            catalogueItemId: 'i1',
            teacherPatronId: 't-foreign',
            copyCount: 5,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-21',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(teacherSql).toMatch(
      /WHERE\s+person_id\s*=\s*\$1::uuid\s+AND\s+school_id\s*=\s*\$2::uuid/,
    );
  });

  it('classId validation queries sis_classes with school_id', async () => {
    let classSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_catalogue_items')) return [{ ok: 1 }];
      if (call.sql.includes('FROM hr_employees')) return [{ ok: 1 }];
      if (call.sql.includes('FROM sis_classes')) {
        classSql = call.sql;
        return []; // foreign-school class → 0 rows
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(
          {
            catalogueItemId: 'i1',
            teacherPatronId: 't1',
            classId: 'class-foreign',
            copyCount: 5,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-21',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/classId does not match a class in this school/);
    expect(classSql).toMatch(/FROM sis_classes WHERE id = \$1::uuid AND school_id = \$2::uuid/);
  });
});

// ─────────────────────────────────────────────────────────────────
// R-B3 — Recommendations cross-school hardening
// ─────────────────────────────────────────────────────────────────

describe('REVIEW-P2C25 R-B3 — recommendation school-scope', () => {
  it('student self-read joins through sis_students.school_id', async () => {
    let probeSql = '';
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM sis_students s') &&
        call.sql.includes('platform.platform_students')
      ) {
        probeSql = call.sql;
        return []; // cross-school identity → 0 rows
      }
      return [];
    });
    const perm = makePermCheck(() => false);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.listForStudent('s-foreign', STUDENT_ACTOR, {})),
    ).rejects.toThrow(ForbiddenException);
    expect(probeSql).toMatch(/s\.school_id\s*=\s*\$2::uuid/);
  });

  it('guardian read joins sis_student_guardians + sis_students.school_id', async () => {
    let probeSql = '';
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM sis_student_guardians sg') &&
        call.sql.includes('sis_students s')
      ) {
        probeSql = call.sql;
        return []; // cross-school student → guardian rejected
      }
      return [];
    });
    const perm = makePermCheck(() => false);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.listForStudent('s-foreign', PARENT_ACTOR, {})),
    ).rejects.toThrow(ForbiddenException);
    expect(probeSql).toMatch(/JOIN sis_students s ON s\.id = sg\.student_id/);
    expect(probeSql).toMatch(/s\.school_id\s*=\s*\$2::uuid/);
  });

  it('librarian read also validates student belongs to school', async () => {
    let probeSql = '';
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM sis_students WHERE id') &&
        call.sql.includes('school_id') &&
        !call.sql.includes('JOIN')
      ) {
        probeSql = call.sql;
        return []; // foreign student → 404
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.listForStudent('s-foreign', ADMIN_ACTOR, {})),
    ).rejects.toThrow(NotFoundException);
    expect(probeSql).toMatch(/WHERE id = \$1::uuid AND school_id = \$2::uuid/);
  });

  it('list SQL joins recommendations through sis_students with school predicate', async () => {
    let listSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sis_students WHERE')) return [{ ok: 1 }]; // student is in school
      if (call.sql.includes('FROM lib_recommendations r')) {
        listSql = call.sql;
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    await withTenant(() => svc.listForStudent('s-1', ADMIN_ACTOR, {}));
    expect(listSql).toMatch(/JOIN sis_students s ON s\.id = r\.student_id/);
    expect(listSql).toMatch(/s\.school_id\s*=\s*\$2::uuid/);
  });

  it('dismiss locks through sis_students join with school_id', async () => {
    let lockSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_recommendations r') && call.sql.includes('FOR UPDATE')) {
        lockSql = call.sql;
        return []; // foreign-school recommendation → 0 rows
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    await expect(withTenant(() => svc.dismiss('rec-foreign', ADMIN_ACTOR))).rejects.toThrow(
      NotFoundException,
    );
    expect(lockSql).toMatch(/JOIN sis_students s ON s\.id = r\.student_id/);
    expect(lockSql).toMatch(/s\.school_id\s*=\s*\$2::uuid/);
    expect(lockSql).toMatch(/FOR UPDATE OF r/);
  });

  it('replaceForStudent refuses cross-school student', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sis_students WHERE')) return []; // foreign → empty
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.replaceForStudent('s-foreign', [
          { itemId: 'i1', reasonType: 'COLLABORATIVE_FILTERING', score: 0.9 },
        ]),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('replaceForStudent refuses cross-school recommended items', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sis_students WHERE')) return [{ ok: 1 }]; // student OK
      if (call.sql.includes('FROM lib_catalogue_items WHERE school_id')) return []; // no items match
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.replaceForStudent('s-1', [
          { itemId: 'i-foreign', reasonType: 'NEW_ARRIVAL', score: 0.5 },
        ]),
      ),
    ).rejects.toThrow(/Recommended items do not belong to this school/);
  });
});

// ─────────────────────────────────────────────────────────────────
// R-B4 — Reading-list item mutation paths school-scope
// ─────────────────────────────────────────────────────────────────

describe('REVIEW-P2C25 R-B4 — reading-list item school-scope', () => {
  it('listItems SQL joins through lib_reading_lists with school_id', async () => {
    let listSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_reading_list_items i')) {
        listSql = call.sql;
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ReadingListService(fake.tenantPrisma as never, perm);
    await withTenant(() => svc.listItems('list-1'));
    expect(listSql).toMatch(/JOIN lib_reading_lists l ON l\.id = i\.reading_list_id/);
    expect(listSql).toMatch(/l\.school_id\s*=\s*\$2::uuid/);
  });

  it('patchItem lock JOINs through parent list with school_id', async () => {
    let lockSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_reading_list_items i') && call.sql.includes('FOR UPDATE')) {
        lockSql = call.sql;
        return []; // foreign-school item → not found
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ReadingListService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.patchItem('item-foreign', { sortOrder: 5 }, ADMIN_ACTOR)),
    ).rejects.toThrow(NotFoundException);
    expect(lockSql).toMatch(/JOIN lib_reading_lists l ON l\.id = i\.reading_list_id/);
    expect(lockSql).toMatch(/l\.school_id\s*=\s*\$2::uuid/);
    expect(lockSql).toMatch(/FOR UPDATE OF i/);
  });

  it('removeItem DELETE uses USING lib_reading_lists with school_id', async () => {
    let deleteSql = '';
    const fake = makeFake((call) => {
      if (call.fn === 'e' && call.sql.includes('DELETE FROM lib_reading_list_items')) {
        deleteSql = call.sql;
        return 0; // foreign-school item → 0 rows
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ReadingListService(fake.tenantPrisma as never, perm);
    await expect(withTenant(() => svc.removeItem('item-foreign', ADMIN_ACTOR))).rejects.toThrow(
      NotFoundException,
    );
    expect(deleteSql).toMatch(/USING lib_reading_lists l/);
    expect(deleteSql).toMatch(/l\.school_id\s*=\s*\$2::uuid/);
  });
});

// ─────────────────────────────────────────────────────────────────
// R-B5 — ILL patch + sweep + LENT catalogue validation
// ─────────────────────────────────────────────────────────────────

describe('REVIEW-P2C25 R-B5 — ILL school-scope', () => {
  it('patch lock + UPDATE carry id + school_id', async () => {
    let lockSql = '';
    let updateSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_interlibrary_loans') && call.sql.includes('FOR UPDATE')) {
        lockSql = call.sql;
        return [{ id: 'ill-1', status: 'REQUESTED' }];
      }
      if (call.fn === 'e' && call.sql.includes('UPDATE lib_interlibrary_loans')) {
        updateSql = call.sql;
      }
      // Stub for the post-patch getById reload — also needs to honour
      // the school_id predicate.
      if (
        call.sql.includes('FROM lib_interlibrary_loans il') ||
        (call.sql.includes('FROM lib_interlibrary_loans') && call.sql.includes('school_id'))
      ) {
        return [
          {
            id: 'ill-1',
            school_id: SCHOOL.schoolId,
            loan_direction: 'BORROWED',
            partner_institution: 'Eastside',
            catalogue_item_id: null,
            title: 'T',
            author: null,
            isbn: null,
            request_date: '2026-05-01',
            received_date: null,
            sent_date: null,
            due_date: null,
            returned_date: null,
            status: 'IN_TRANSIT',
            notes: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new InterlibraryLoanService(fake.tenantPrisma as never, perm);
    await withTenant(() => svc.patch('ill-1', { status: 'IN_TRANSIT' }, ADMIN_ACTOR));
    expect(lockSql).toMatch(/WHERE id = \$1::uuid AND school_id = \$2::uuid FOR UPDATE/);
    expect(updateSql).toMatch(/WHERE id = \$1::uuid AND school_id = \$2::uuid/);
  });

  it('sweepOverdueForCurrentTenant binds to school_id', async () => {
    let sweepSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE lib_interlibrary_loans')) {
        sweepSql = call.sql;
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new InterlibraryLoanService(fake.tenantPrisma as never, perm);
    await withTenant(() => svc.sweepOverdueForCurrentTenant());
    expect(sweepSql).toMatch(/WHERE\s+school_id\s*=\s*\$1::uuid/);
    expect(sweepSql).toMatch(/ACTIVE/);
  });

  it('LENT catalogueItemId validated against current school', async () => {
    let probeSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_catalogue_items WHERE id')) {
        probeSql = call.sql;
        return []; // foreign-school catalogue item → BadRequest
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new InterlibraryLoanService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(
          {
            loanDirection: 'LENT',
            partnerInstitution: 'Eastside',
            title: 'The Outsiders',
            catalogueItemId: 'i-foreign',
            requestDate: '2026-05-01',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/does not match a catalogue item in this school/);
    expect(probeSql).toMatch(/WHERE id = \$1::uuid AND school_id = \$2::uuid/);
  });
});

// ─────────────────────────────────────────────────────────────────
// R-B6 — Catalogue import markTerminal + intermediates school-scope
// ─────────────────────────────────────────────────────────────────

describe('REVIEW-P2C25 R-B6 — import job mutations school-scope', () => {
  it('PARSING + IMPORTING + COMPLETED updates all carry school_id', async () => {
    let parsingSql = '';
    let importingSql = '';
    let terminalSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_catalogue_import_jobs WHERE')) {
        return [
          {
            id: 'job-1',
            school_id: SCHOOL.schoolId,
            status: 'QUEUED',
            import_type: 'ISBN_BATCH',
            source_file_s3_key: 'inline://["9780544336261"]',
          },
        ];
      }
      // Skip the ISBN existence-check path so the worker can complete.
      if (call.sql.includes('FROM lib_catalogue_items') && call.sql.includes('isbn')) {
        return [];
      }
      if (call.sql.includes('UPDATE lib_catalogue_import_jobs')) {
        if (call.sql.includes("'PARSING'")) parsingSql = call.sql;
        if (call.sql.includes("'IMPORTING'")) importingSql = call.sql;
        if (call.sql.includes('records_imported')) terminalSql = call.sql;
      }
      return [];
    });
    const outbox = makeOutbox();
    const perm = makePermCheck(() => true);
    const svc = new CatalogueImportService(
      fake.tenantPrisma as never,
      perm,
      outbox.outbox as never,
    );
    await withTenant(() => svc.processQueuedJob('job-1'));
    // All three updates must carry school_id predicate.
    expect(parsingSql).toMatch(/WHERE\s+id\s*=\s*\$1::uuid\s+AND\s+school_id\s*=\s*\$2::uuid/);
    expect(importingSql).toMatch(/WHERE\s+id\s*=\s*\$1::uuid\s+AND\s+school_id\s*=\s*\$2::uuid/);
    expect(terminalSql).toMatch(/AND\s+school_id\s*=\s*\$7::uuid/);
    // The outbox emit fires with the COMPLETED status post-update.
    expect(outbox.emitted).toHaveLength(1);
    expect(outbox.emitted[0]!.topic).toBe('lib.import.completed');
  });
});

void TEACHER_ACTOR;
