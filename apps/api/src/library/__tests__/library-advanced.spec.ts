import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '../../tenant/tenant.context';
import { deterministicLibImportCompletedEventId } from '../event-ids';
import { ClassSetService } from '../class-set.service';
import { RecommendationService } from '../recommendation.service';
import { InterlibraryLoanService } from '../interlibrary-loan.service';
import { CatalogueImportService } from '../catalogue-import.service';

/**
 * P2-25a — Library Advanced unit tests.
 *
 * Covers:
 *   - deterministicLibImportCompletedEventId — v5-shape UUID +
 *     stability across calls.
 *   - ClassSetService.create — KEYSTONE — INSERT chain runs the full
 *     contract (validate item + teacher + lock copies + INSERT parent
 *     + INSERT N children + flip copies). Refusal paths: copy_count <
 *     available, bogus teacher.
 *   - ClassSetService.returnCopies — state machine walks PARTIALLY
 *     RETURNED → RETURNED. Refuses over-return.
 *   - ClassSetService.sweepOverdueForCurrentTenant — SQL shape.
 *   - RecommendationService.replaceForStudent — DELETE + INSERT
 *     contract for the full-replace pattern. Caps at 20.
 *   - InterlibraryLoanService.patch — state machine transitions.
 *     ALLOWED_TRANSITIONS gate.
 *   - CatalogueImportService.create — ISBN_BATCH inline encoding.
 *     ISBN dedup contract.
 *   - CatalogueImportService.markTerminal — emits lib.import.completed
 *     via outbox with deterministic event_id inside the tx.
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
  const emitted: Array<{
    topic: string;
    sourceModule: string;
    key?: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: Record<string, unknown>) => {
      emitted.push({
        topic: opts.topic as string,
        sourceModule: opts.sourceModule as string,
        key: opts.key as string | undefined,
        eventId: opts.eventId as string | undefined,
        payload: opts.payload as Record<string, unknown>,
      });
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
// 1. Deterministic event ids
// ─────────────────────────────────────────────────────────────────

describe('deterministicLibImportCompletedEventId', () => {
  it('is a v5-shape UUID', () => {
    const id = deterministicLibImportCompletedEventId('019dabcd-0000-7000-8000-000000000001');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(id[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(id[19]!.toLowerCase());
  });

  it('is stable across calls', () => {
    expect(deterministicLibImportCompletedEventId('import-1')).toBe(
      deterministicLibImportCompletedEventId('import-1'),
    );
  });

  it('different inputs produce different ids', () => {
    expect(deterministicLibImportCompletedEventId('a')).not.toBe(
      deterministicLibImportCompletedEventId('b'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. ClassSetService — keystone create + return + sweep
// ─────────────────────────────────────────────────────────────────

describe('ClassSetService.create — KEYSTONE', () => {
  it('refuses non-librarian actors with 403', async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => false);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(
          {
            catalogueItemId: '019aaaa1-0000-7000-8000-000000000001',
            teacherPatronId: '019aaaa1-0000-7000-8000-000000000002',
            copyCount: 5,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-21',
          },
          TEACHER_ACTOR,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses copyCount < 1 with 400 (defence-in-depth above DTO @Min)', async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(
          {
            catalogueItemId: '019aaaa1-0000-7000-8000-000000000001',
            teacherPatronId: '019aaaa1-0000-7000-8000-000000000002',
            copyCount: 0,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-21',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses dueDate < checkoutDate with 400', async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(
          {
            catalogueItemId: '019aaaa1-0000-7000-8000-000000000001',
            teacherPatronId: '019aaaa1-0000-7000-8000-000000000002',
            copyCount: 5,
            checkoutDate: '2026-05-21',
            dueDate: '2026-05-01',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses bogus catalogueItemId with 404', async () => {
    let phase = 'item';
    const fake = makeFake((call) => {
      if (phase === 'item' && call.sql.includes('FROM lib_catalogue_items')) {
        return []; // not found
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(
          {
            catalogueItemId: '019aaaa1-0000-7000-8000-000000000001',
            teacherPatronId: '019aaaa1-0000-7000-8000-000000000002',
            copyCount: 5,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-21',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses bogus teacherPatronId with 400 (no hr_employees row in tenant)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_catalogue_items')) return [{ ok: 1 }];
      if (call.sql.includes('FROM hr_employees')) return []; // teacher not in tenant
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(
          {
            catalogueItemId: '019aaaa1-0000-7000-8000-000000000001',
            teacherPatronId: '019aaaa1-0000-7000-8000-000000000002',
            copyCount: 5,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-21',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses copyCount > available copies with 400', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_catalogue_items')) return [{ ok: 1 }];
      if (call.sql.includes('FROM hr_employees')) return [{ ok: 1 }];
      if (call.sql.includes('FROM lib_catalogue_copies')) {
        // Only 3 available copies — requesting 5
        return [
          { id: 'copy-1', barcode: 'B1' },
          { id: 'copy-2', barcode: 'B2' },
          { id: 'copy-3', barcode: 'B3' },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(
          {
            catalogueItemId: '019aaaa1-0000-7000-8000-000000000001',
            teacherPatronId: '019aaaa1-0000-7000-8000-000000000002',
            copyCount: 5,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-21',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/only 3 copies/);
  });

  it('happy path issues N INSERTs + N UPDATEs + class set INSERT in one tx', async () => {
    const copyRows = Array.from({ length: 5 }, (_, i) => ({
      id: 'copy-' + (i + 1),
      barcode: 'B' + (i + 1),
    }));
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_catalogue_items')) return [{ ok: 1 }];
      if (call.sql.includes('FROM hr_employees')) return [{ ok: 1 }];
      if (call.sql.includes('FROM lib_catalogue_copies') && call.sql.includes('FOR UPDATE')) {
        return copyRows;
      }
      // Final reload via getById uses SELECT_CLASS_SET_BASE
      if (call.sql.includes('FROM lib_class_set_checkouts cs')) {
        return [
          {
            id: 'cs-1',
            school_id: SCHOOL.schoolId,
            catalogue_item_id: '019aaaa1-0000-7000-8000-000000000001',
            catalogue_item_title: 'Number the Stars',
            catalogue_item_author: 'Lois Lowry',
            teacher_patron_id: '019aaaa1-0000-7000-8000-000000000002',
            teacher_first: 'James',
            teacher_last: 'Rivera',
            class_id: null,
            copy_count: 5,
            checkout_date: '2026-05-01',
            due_date: '2026-05-21',
            returned_count: 0,
            status: 'ACTIVE',
            notes: null,
            created_at: '2026-05-01T00:00:00+00',
            updated_at: '2026-05-01T00:00:00+00',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    const result = await withTenant(() =>
      svc.create(
        {
          catalogueItemId: '019aaaa1-0000-7000-8000-000000000001',
          teacherPatronId: '019aaaa1-0000-7000-8000-000000000002',
          copyCount: 5,
          checkoutDate: '2026-05-01',
          dueDate: '2026-05-21',
        },
        ADMIN_ACTOR,
      ),
    );

    // Confirm the keystone INSERT chain:
    //   1 parent INSERT into lib_class_set_checkouts
    //   5 child INSERTs into lib_checkouts (one per copy)
    //   5 UPDATEs on lib_catalogue_copies
    const inserts = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO lib_class_set_checkouts'),
    );
    const childInserts = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO lib_checkouts'),
    );
    const copyFlips = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE lib_catalogue_copies SET is_available = false'),
    );
    expect(inserts.length).toBe(1);
    expect(childInserts.length).toBe(5);
    expect(copyFlips.length).toBe(5);
    // Each child INSERT carries class_set_checkout_id
    for (const i of childInserts) {
      expect(i.sql).toContain('class_set_checkout_id');
    }
    expect(result.status).toBe('ACTIVE');
    expect(result.copyCount).toBe(5);
  });
});

describe('ClassSetService.returnCopies — state machine', () => {
  it('refuses over-return', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_class_set_checkouts') && call.sql.includes('FOR UPDATE')) {
        return [
          {
            id: 'cs-1',
            copy_count: 5,
            returned_count: 3,
            status: 'PARTIALLY_RETURNED',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.returnCopies('cs-1', { copiesReturned: 5 }, ADMIN_ACTOR)),
    ).rejects.toThrow(/only 2 copies are still out/);
  });

  it('flips status to RETURNED when returned_count = copy_count', async () => {
    let updated: { returned: number; status: string } | null = null;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_class_set_checkouts') && call.sql.includes('FOR UPDATE')) {
        return [
          {
            id: 'cs-1',
            copy_count: 5,
            returned_count: 3,
            status: 'PARTIALLY_RETURNED',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (call.sql.includes('FROM lib_checkouts co') && call.sql.includes('FOR UPDATE')) {
        return [
          { id: 'co-1', copy_id: 'copy-1' },
          { id: 'co-2', copy_id: 'copy-2' },
        ];
      }
      if (call.sql.includes('UPDATE lib_class_set_checkouts SET returned_count')) {
        updated = {
          returned: Number(call.args[0]),
          status: String(call.args[1]),
        };
      }
      // getById reload
      if (call.sql.includes('FROM lib_class_set_checkouts cs')) {
        return [
          {
            id: 'cs-1',
            school_id: SCHOOL.schoolId,
            catalogue_item_id: 'i1',
            catalogue_item_title: 'T',
            catalogue_item_author: 'A',
            teacher_patron_id: 't1',
            teacher_first: 'F',
            teacher_last: 'L',
            class_id: null,
            copy_count: 5,
            checkout_date: '2026-05-01',
            due_date: '2026-05-21',
            returned_count: 5,
            status: 'RETURNED',
            notes: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    const result = await withTenant(() =>
      svc.returnCopies('cs-1', { copiesReturned: 2 }, ADMIN_ACTOR),
    );
    expect(updated).toEqual({ returned: 5, status: 'RETURNED' });
    expect(result.status).toBe('RETURNED');
  });
});

describe('ClassSetService.sweepOverdueForCurrentTenant', () => {
  it('flips ACTIVE + PARTIALLY_RETURNED past due to OVERDUE', async () => {
    const fake = makeFake(() => [{ id: 'cs-1' }, { id: 'cs-2' }]);
    const perm = makePermCheck(() => true);
    const svc = new ClassSetService(fake.tenantPrisma as never, perm);
    const ids = await withTenant(() => svc.sweepOverdueForCurrentTenant());
    expect(ids).toEqual(['cs-1', 'cs-2']);
    const update = fake.capture.find((c) => c.sql.includes('UPDATE lib_class_set_checkouts'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("status = 'OVERDUE'");
    expect(update!.sql).toContain("status IN ('ACTIVE', 'PARTIALLY_RETURNED')");
    expect(update!.sql).toContain('due_date < CURRENT_DATE');
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. RecommendationService — full-replace contract
// ─────────────────────────────────────────────────────────────────

describe('RecommendationService.replaceForStudent — full DELETE + INSERT', () => {
  it('DELETEs all rows then INSERTs each fresh row', async () => {
    const fresh = [
      {
        itemId: '019aaaa1-0000-7000-8000-000000000001',
        reasonType: 'COLLABORATIVE_FILTERING' as const,
        score: 0.92,
      },
      {
        itemId: '019aaaa1-0000-7000-8000-000000000002',
        reasonType: 'READING_LEVEL_MATCH' as const,
        score: 0.85,
      },
    ];
    const fake = makeFake((call) => {
      // REVIEW-P2C25 BLOCKING 3 — student-in-school + item ownership
      // probes stub returning hits so the happy path can complete.
      if (call.sql.includes('FROM sis_students WHERE')) return [{ ok: 1 }];
      if (call.sql.includes('FROM lib_catalogue_items WHERE school_id')) {
        return fresh.map((f) => ({ id: f.itemId }));
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    const n = await withTenant(() =>
      svc.replaceForStudent('019stu1-0000-7000-8000-000000000001', fresh),
    );
    expect(n).toBe(2);

    const deletes = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.startsWith('DELETE FROM lib_recommendations'),
    );
    const inserts = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.startsWith('INSERT INTO lib_recommendations'),
    );
    expect(deletes.length).toBe(1);
    expect(inserts.length).toBe(2);
  });

  it('caps the input array at 20', async () => {
    const fresh = Array.from({ length: 30 }, (_, i) => ({
      itemId: '019aaaa1-0000-7000-8000-' + String(i).padStart(12, '0'),
      reasonType: 'NEW_ARRIVAL' as const,
      score: 0.5,
    }));
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sis_students WHERE')) return [{ ok: 1 }];
      if (call.sql.includes('FROM lib_catalogue_items WHERE school_id')) {
        // Return only the 20 the service will cap to.
        return fresh.slice(0, 20).map((f) => ({ id: f.itemId }));
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    const n = await withTenant(() =>
      svc.replaceForStudent('019stu1-0000-7000-8000-000000000001', fresh),
    );
    expect(n).toBe(20);
    const inserts = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.startsWith('INSERT INTO lib_recommendations'),
    );
    expect(inserts.length).toBe(20);
  });
});

describe('RecommendationService.dismiss', () => {
  it('refuses non-owner students with 403', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_recommendations') && call.sql.includes('FOR UPDATE')) {
        return [{ id: 'r1', student_id: 'other-student', dismissed_at: null }];
      }
      if (call.sql.includes('FROM sis_students s')) {
        return []; // no link to actor
      }
      return [];
    });
    const perm = makePermCheck(() => false);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    await expect(withTenant(() => svc.dismiss('r1', STUDENT_ACTOR))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses parents who are not librarians/admins with 403', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_recommendations') && call.sql.includes('FOR UPDATE')) {
        return [{ id: 'r1', student_id: 'maya-student', dismissed_at: null }];
      }
      return [];
    });
    const perm = makePermCheck(() => false);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    await expect(withTenant(() => svc.dismiss('r1', PARENT_ACTOR))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses already-dismissed rows', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_recommendations') && call.sql.includes('FOR UPDATE')) {
        return [{ id: 'r1', student_id: 'maya-student', dismissed_at: '2026-05-01T00:00:00+00' }];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new RecommendationService(fake.tenantPrisma as never, perm);
    await expect(withTenant(() => svc.dismiss('r1', ADMIN_ACTOR))).rejects.toThrow(
      BadRequestException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. InterlibraryLoanService — state machine
// ─────────────────────────────────────────────────────────────────

describe('InterlibraryLoanService.patch — state machine', () => {
  it('refuses illegal transition (RETURNED is terminal)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_interlibrary_loans') && call.sql.includes('FOR UPDATE')) {
        return [{ id: 'ill-1', status: 'RETURNED' }];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new InterlibraryLoanService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.patch('ill-1', { status: 'ACTIVE' }, ADMIN_ACTOR)),
    ).rejects.toThrow(/Cannot transition ILL from RETURNED to ACTIVE/);
  });

  it('allows REQUESTED → IN_TRANSIT', async () => {
    let updated = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_interlibrary_loans') && call.sql.includes('FOR UPDATE')) {
        return [{ id: 'ill-1', status: 'REQUESTED' }];
      }
      if (call.sql.includes('UPDATE lib_interlibrary_loans SET')) {
        updated = true;
      }
      // getById reload
      return [
        {
          id: 'ill-1',
          school_id: SCHOOL.schoolId,
          loan_direction: 'BORROWED',
          partner_institution: 'Eastside',
          catalogue_item_id: null,
          title: 'The Outsiders',
          author: 'S. E. Hinton',
          isbn: '978-0140385724',
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
    });
    const perm = makePermCheck(() => true);
    const svc = new InterlibraryLoanService(fake.tenantPrisma as never, perm);
    const result = await withTenant(() =>
      svc.patch('ill-1', { status: 'IN_TRANSIT' }, ADMIN_ACTOR),
    );
    expect(updated).toBe(true);
    expect(result.status).toBe('IN_TRANSIT');
  });

  it('refuses non-librarian writers with 403', async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => false);
    const svc = new InterlibraryLoanService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.patch('ill-1', { status: 'IN_TRANSIT' }, TEACHER_ACTOR)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('sweepOverdueForCurrentTenant SQL filters ACTIVE past due_date', async () => {
    const fake = makeFake(() => [{ id: 'ill-1' }]);
    const perm = makePermCheck(() => true);
    const svc = new InterlibraryLoanService(fake.tenantPrisma as never, perm);
    const ids = await withTenant(() => svc.sweepOverdueForCurrentTenant());
    expect(ids).toEqual(['ill-1']);
    const sql = fake.capture.find((c) => c.sql.includes('UPDATE lib_interlibrary_loans'));
    expect(sql).toBeDefined();
    expect(sql!.sql).toContain("status = 'OVERDUE'");
    expect(sql!.sql).toContain("status = 'ACTIVE'");
    expect(sql!.sql).toContain('due_date < CURRENT_DATE');
  });
});

describe('InterlibraryLoanService.create', () => {
  it('refuses LENT without catalogueItemId per schema direction_chk', async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new InterlibraryLoanService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(
          {
            loanDirection: 'LENT',
            partnerInstitution: 'Westside',
            title: 'Number the Stars',
            requestDate: '2026-05-01',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/LENT loans require catalogueItemId/);
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. CatalogueImportService
// ─────────────────────────────────────────────────────────────────

describe('CatalogueImportService.create', () => {
  it('refuses ISBN_BATCH with empty isbns', async () => {
    const fake = makeFake(() => []);
    const ob = makeOutbox();
    const perm = makePermCheck(() => true);
    const svc = new CatalogueImportService(fake.tenantPrisma as never, perm, ob.outbox as never);
    await expect(
      withTenant(() => svc.create({ importType: 'ISBN_BATCH', isbns: [] }, ADMIN_ACTOR)),
    ).rejects.toThrow(/non-empty isbns/);
  });

  it('refuses CSV_UPLOAD without sourceFileS3Key', async () => {
    const fake = makeFake(() => []);
    const ob = makeOutbox();
    const perm = makePermCheck(() => true);
    const svc = new CatalogueImportService(fake.tenantPrisma as never, perm, ob.outbox as never);
    await expect(
      withTenant(() => svc.create({ importType: 'CSV_UPLOAD' }, ADMIN_ACTOR)),
    ).rejects.toThrow(/sourceFileS3Key/);
  });

  it('refuses non-librarian actors with 403', async () => {
    const fake = makeFake(() => []);
    const ob = makeOutbox();
    const perm = makePermCheck(() => false);
    const svc = new CatalogueImportService(fake.tenantPrisma as never, perm, ob.outbox as never);
    await expect(
      withTenant(() =>
        svc.create({ importType: 'ISBN_BATCH', isbns: ['9781234567890'] }, TEACHER_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('ISBN_BATCH inline-encodes the ISBN list into source_file_s3_key', async () => {
    let insertSql: string | null = null;
    let insertArgs: unknown[] | null = null;
    const fake = makeFake((call) => {
      if (call.fn === 'e' && call.sql.startsWith('INSERT INTO lib_catalogue_import_jobs')) {
        insertSql = call.sql;
        insertArgs = call.args;
      }
      // getById reload
      if (call.sql.includes('FROM lib_catalogue_import_jobs j')) {
        return [
          {
            id: 'job-1',
            school_id: SCHOOL.schoolId,
            import_type: 'ISBN_BATCH',
            source_file_s3_key: 'inline://["978-1","978-2"]',
            total_records: 2,
            records_imported: 0,
            records_skipped: 0,
            records_failed: 0,
            status: 'QUEUED',
            initiated_by: 'admin-emp',
            initiator_first: 'A',
            initiator_last: 'B',
            error_log_s3_key: null,
            started_at: null,
            completed_at: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
    const ob = makeOutbox();
    const perm = makePermCheck(() => true);
    const svc = new CatalogueImportService(fake.tenantPrisma as never, perm, ob.outbox as never);
    const result = await withTenant(() =>
      svc.create({ importType: 'ISBN_BATCH', isbns: ['978-1', '978-2'] }, ADMIN_ACTOR),
    );
    expect(insertSql).toBeTruthy();
    // The 4th arg is source_file_s3_key — must start with inline://
    expect(typeof insertArgs![3]).toBe('string');
    expect(insertArgs![3]).toMatch(/^inline:\/\/\["978-1","978-2"\]$/);
    // total_records is arg index 4
    expect(insertArgs![4]).toBe(2);
    expect(result.totalRecords).toBe(2);
  });
});

describe('CatalogueImportService.processQueuedJob — KEYSTONE', () => {
  it('emits lib.import.completed via outbox with deterministic event_id on COMPLETED', async () => {
    const jobId = '019aaaa1-0000-7000-8000-000000000001';
    let stage: 'load' | 'parsing' | 'importing' | 'isbnLookup1' | 'isbnLookup2' | 'terminal' =
      'load';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_catalogue_import_jobs') && stage === 'load') {
        stage = 'parsing';
        return [
          {
            id: jobId,
            import_type: 'ISBN_BATCH',
            source_file_s3_key: 'inline://["978-A","978-B"]',
            school_id: SCHOOL.schoolId,
            status: 'QUEUED',
          },
        ];
      }
      // ISBN lookups — first ISBN exists, second is new
      if (
        call.sql.includes('FROM lib_catalogue_items WHERE school_id') &&
        call.sql.includes('isbn')
      ) {
        const isbn = call.args[1];
        if (isbn === '978-A') return [{ id: 'existing-id' }];
        return [];
      }
      return [];
    });
    const ob = makeOutbox();
    const perm = makePermCheck(() => true);
    const svc = new CatalogueImportService(fake.tenantPrisma as never, perm, ob.outbox as never);
    await withTenant(() => svc.processQueuedJob(jobId));

    expect(ob.emitted.length).toBe(1);
    const emit = ob.emitted[0]!;
    expect(emit.topic).toBe('lib.import.completed');
    expect(emit.sourceModule).toBe('library');
    expect(emit.eventId).toBe(deterministicLibImportCompletedEventId(jobId));
    expect(emit.payload).toMatchObject({
      importJobId: jobId,
      status: 'COMPLETED',
      recordsImported: 1,
      recordsSkipped: 1,
      recordsFailed: 0,
      sourceRefId: jobId,
    });
  });

  it('skipped count increments on duplicate ISBN — dedup contract', async () => {
    const jobId = '019aaaa1-0000-7000-8000-000000000002';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM lib_catalogue_import_jobs')) {
        return [
          {
            id: jobId,
            import_type: 'ISBN_BATCH',
            source_file_s3_key: 'inline://["978-DUP","978-DUP","978-NEW"]',
            school_id: SCHOOL.schoolId,
            status: 'QUEUED',
          },
        ];
      }
      if (
        call.sql.includes('FROM lib_catalogue_items WHERE school_id') &&
        call.sql.includes('isbn')
      ) {
        const isbn = call.args[1];
        if (isbn === '978-DUP') return [{ id: 'existing' }];
        return [];
      }
      return [];
    });
    const ob = makeOutbox();
    const perm = makePermCheck(() => true);
    const svc = new CatalogueImportService(fake.tenantPrisma as never, perm, ob.outbox as never);
    await withTenant(() => svc.processQueuedJob(jobId));

    expect(ob.emitted.length).toBe(1);
    expect(ob.emitted[0]!.payload).toMatchObject({
      recordsImported: 1,
      recordsSkipped: 2,
      recordsFailed: 0,
    });
  });

  it('non-QUEUED jobs are silent no-ops (idempotent re-run)', async () => {
    const jobId = '019aaaa1-0000-7000-8000-000000000003';
    const fake = makeFake(() => [
      {
        id: jobId,
        import_type: 'ISBN_BATCH',
        source_file_s3_key: 'inline://["978-X"]',
        school_id: SCHOOL.schoolId,
        status: 'COMPLETED',
      },
    ]);
    const ob = makeOutbox();
    const perm = makePermCheck(() => true);
    const svc = new CatalogueImportService(fake.tenantPrisma as never, perm, ob.outbox as never);
    await withTenant(() => svc.processQueuedJob(jobId));
    expect(ob.emitted.length).toBe(0);
  });
});
