import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, type TenantInfo } from '@shared/tenant/tenant.context';
import { RecipeService } from './recipe.service';
import { InventoryService } from './inventory.service';
import { TransferService } from './transfer.service';
import { StaffMealService } from './staff-meal.service';

/**
 * P2-10a Food Service Advanced — keystone unit tests.
 *
 *   1. Recipe addIngredient triggers allergen UNION + cost_per_serving
 *      recompute on the parent recipe row.
 *   2. Recipe deleteIngredient triggers the same recompute.
 *   3. Recipe scaling computes scaleFactor and per-ingredient scaled
 *      quantities.
 *   4. Inventory transactions schema is IMMUTABLE — neither
 *      InventoryService nor TransferService exposes update/delete
 *      methods for transactions.
 *   5. Inventory.receive emits fds.inventory.low only when the new
 *      level crosses below reorder_threshold from above.
 *   6. Inventory.usage that crosses downward through reorder_threshold
 *      emits fds.inventory.low with full ADR-057 envelope shape.
 *   7. TransferService.complete writes paired TRANSFER_OUT +
 *      TRANSFER_IN rows with a shared transfer_reference_id.
 *   8. TransferService.complete refuses non-APPROVED transitions.
 *   9. StaffMealService.charge refuses overdraw on PREPAID accounts.
 *   10. StaffMealService.charge no-ops balance on COMPLIMENTARY accounts.
 *   11. Recipe + Inventory + Transfer + StaffMeal services refuse
 *       non-admin non-staff actors at the assertCanManage gate.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa',
  schemaName: 'tenant_demo',
  organisationId: null,
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'BASIC',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e0cf8-aaaa-7000-aaaa-000000000001',
  personId: '019e0cf8-aaaa-7000-aaaa-000000000010',
  personType: 'STAFF',
  isSchoolAdmin: true,
  employeeId: '019e0cf8-aaaa-7000-aaaa-000000000100',
} as never;

const STAFF_ACTOR = {
  accountId: '019e0cf8-aaaa-7000-aaaa-000000000002',
  personId: '019e0cf8-aaaa-7000-aaaa-000000000020',
  personType: 'STAFF',
  isSchoolAdmin: false,
  employeeId: '019e0cf8-aaaa-7000-aaaa-000000000200',
} as never;

const STUDENT_ACTOR = {
  accountId: '019e0cf8-aaaa-7000-aaaa-000000000003',
  personId: '019e0cf8-aaaa-7000-aaaa-000000000030',
  personType: 'STUDENT',
  isSchoolAdmin: false,
  employeeId: null,
} as never;

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
    getPlatformClient: () => client,
  };
  return { capture, client, tenantPrisma };
}

function makeKafka() {
  const emitted: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
  }> = [];
  const kafka = {
    emit: vi.fn(async (opts: any) => {
      emitted.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
      });
    }),
  };
  return { kafka, emitted };
}

/**
 * REVIEW-P2-10a ROUND 1 BLOCKING 3 — OutboxService stub that captures
 * every `enqueueInTx` call so specs can assert the durable emit
 * keystone fires inside the tx with the deterministic event_id.
 */
function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: vi.fn(async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
      return 'outbox-id';
    }),
  };
  return { outbox, enqueued };
}

/**
 * REVIEW-P2-10a ROUND 1 BLOCKING 4 — PermissionCheckService stub.
 * Default returns `true` so tests that rely on the FDS-006 gate
 * passing continue to work. Override to `false` for the
 * "generic STAFF without FDS-006" denial tests.
 */
function makePermCheck(opts: { allow?: boolean } = {}) {
  const allow = opts.allow ?? true;
  return {
    hasAnyPermissionInTenant: vi.fn(async () => allow),
  };
}

// ── 1. Recipe addIngredient triggers allergen UNION + cost recompute ────

describe('RecipeService — auto-compute allergens + cost_per_serving', () => {
  it('addIngredient recomputes parent recipe.allergens (UNION) + cost_per_serving inside the same tx', async () => {
    // Simulate two ingredients: one with WHEAT, one with MILK. Recipe
    // serving_yield = 100. After ingredient add we expect a UPDATE
    // fds_recipes SET allergens = WHEAT+MILK, cost_per_serving = …
    const ingredientRows = [
      { allergens: ['WHEAT'], quantity: 3.0, unit_cost: 2.1 },
      { allergens: ['MILK'], quantity: 2.0, unit_cost: 1.85 },
    ];
    let recipeUpdate: CapturedCall | undefined;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_recipes WHERE id') && call.sql.includes('FOR UPDATE')) {
        return [{ id: 'r1', school_id: SCHOOL.schoolId, serving_yield: 100 }];
      }
      if (call.sql.includes('FROM fds_recipe_ingredients WHERE recipe_id')) {
        return ingredientRows;
      }
      if (call.sql.includes('SELECT serving_yield FROM fds_recipes WHERE id')) {
        return [{ serving_yield: 100 }];
      }
      // The final getById call: SELECT … FROM fds_recipes WHERE id = $1::uuid AND school_id
      if (
        call.sql.includes('FROM fds_recipes WHERE id') &&
        call.sql.includes('school_id') &&
        !call.sql.includes('FOR UPDATE')
      ) {
        return [
          {
            id: 'r1',
            school_id: SCHOOL.schoolId,
            name: 'Test',
            category: 'ENTREE',
            serving_yield: 100,
            prep_time_minutes: null,
            cook_time_minutes: null,
            instructions: null,
            allergens: ['MILK', 'WHEAT'],
            cost_per_serving: 0.1,
            menu_item_id: null,
            is_active: true,
            created_by: ADMIN_ACTOR.accountId,
            created_at: new Date(),
          },
        ];
      }
      if (
        call.sql.includes('UPDATE fds_recipes SET allergens = $1::text[], cost_per_serving = $2')
      ) {
        recipeUpdate = call;
      }
      return [];
    });
    const svc = new RecipeService(fake.tenantPrisma as never, makePermCheck() as never);
    // RecipeService.addIngredient calls getById at the end which uses
    // tenantContext to read both recipe + ingredients. The fake handler
    // returns the parent FOR UPDATE row for the lock, then triggers the
    // recompute path.
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.addIngredient(
        'r1',
        {
          ingredientName: 'Buttermilk',
          quantity: 2.0,
          unit: 'qt',
          allergens: ['MILK'],
          unitCost: 1.85,
        },
        ADMIN_ACTOR,
      ),
    );
    expect(recipeUpdate).toBeDefined();
    // First param: aggregated allergens as TEXT[]. Order is sorted.
    const allergens = recipeUpdate!.args[0] as string[];
    expect(allergens).toEqual(['MILK', 'WHEAT']);
    // Second param: cost_per_serving = (3.0*2.1 + 2.0*1.85) / 100 = 0.10 (rounded to 2dp)
    const costPerServing = recipeUpdate!.args[1] as number;
    expect(costPerServing).toBeCloseTo(0.1, 2);
  });
});

// ── 2. Recipe deleteIngredient triggers same recompute ──────────────

describe('RecipeService.deleteIngredient', () => {
  it('removes ingredient + recomputes parent recipe aggregates', async () => {
    let recipeUpdate: CapturedCall | undefined;
    let deleteCall: CapturedCall | undefined;
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT i.recipe_id::text AS recipe_id FROM fds_recipe_ingredients')) {
        return [{ recipe_id: 'r1' }];
      }
      if (call.sql.includes('FROM fds_recipe_ingredients WHERE recipe_id')) {
        return []; // No remaining ingredients
      }
      if (call.sql.includes('SELECT serving_yield FROM fds_recipes WHERE id')) {
        return [{ serving_yield: 100 }];
      }
      if (
        call.sql.includes('FROM fds_recipes WHERE id') &&
        call.sql.includes('school_id') &&
        !call.sql.includes('FOR UPDATE')
      ) {
        return [
          {
            id: 'r1',
            school_id: SCHOOL.schoolId,
            name: 'Test',
            category: 'ENTREE',
            serving_yield: 100,
            prep_time_minutes: null,
            cook_time_minutes: null,
            instructions: null,
            allergens: [],
            cost_per_serving: null,
            menu_item_id: null,
            is_active: true,
            created_by: ADMIN_ACTOR.accountId,
            created_at: new Date(),
          },
        ];
      }
      if (call.sql.includes('DELETE FROM fds_recipe_ingredients')) {
        deleteCall = call;
      }
      if (call.sql.includes('UPDATE fds_recipes SET allergens = $1::text[]')) {
        recipeUpdate = call;
      }
      return [];
    });
    const svc = new RecipeService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.deleteIngredient('ing1', ADMIN_ACTOR),
    );
    expect(deleteCall).toBeDefined();
    expect(recipeUpdate).toBeDefined();
    // Empty ingredient list → empty allergens, cost_per_serving = null
    expect(recipeUpdate!.args[0]).toEqual([]);
    expect(recipeUpdate!.args[1]).toBeNull();
  });
});

// ── 3. Recipe scaling ──────────────────────────────────────────────

describe('RecipeService.getScaling', () => {
  it('computes scaleFactor and scaled per-ingredient quantities', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_recipes WHERE id') && call.sql.includes('school_id')) {
        return [{ id: 'r1', serving_yield: 100 }];
      }
      if (call.sql.includes('FROM fds_recipe_ingredients WHERE recipe_id')) {
        return [
          { id: 'ing1', ingredient_name: 'Chicken', quantity: 25, unit: 'lb' },
          { id: 'ing2', ingredient_name: 'Panko', quantity: 3, unit: 'lb' },
        ];
      }
      return [];
    });
    const svc = new RecipeService(fake.tenantPrisma as never, makePermCheck() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.getScaling('r1', 250),
    );
    expect(result.originalServings).toBe(100);
    expect(result.targetServings).toBe(250);
    expect(result.scaleFactor).toBe(2.5);
    expect(result.scaledIngredients).toHaveLength(2);
    const chicken = result.scaledIngredients.find((s) => s.ingredientName === 'Chicken')!;
    expect(chicken.scaledQuantity).toBe(62.5);
    const panko = result.scaledIngredients.find((s) => s.ingredientName === 'Panko')!;
    expect(panko.scaledQuantity).toBe(7.5);
  });

  it('refuses non-positive targetServings', async () => {
    const fake = makeFake(() => []);
    const svc = new RecipeService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.getScaling('r1', 0)),
    ).rejects.toThrow(BadRequestException);
  });
});

// ── 4. IMMUTABLE invariant — no update/delete on transactions ─────────

describe('IMMUTABLE invariant — fds_inventory_transactions', () => {
  it('InventoryService prototype exposes no update or delete method for transactions', () => {
    const proto = InventoryService.prototype as unknown as Record<string, unknown>;
    const keys = Object.getOwnPropertyNames(proto);
    // Any method whose name suggests "update transaction" or
    // "delete transaction" would be a contract violation.
    const violations = keys.filter((k) => {
      const lower = k.toLowerCase();
      return (
        (lower.startsWith('update') && lower.includes('transaction')) ||
        (lower.startsWith('delete') && lower.includes('transaction')) ||
        (lower.startsWith('patch') && lower.includes('transaction')) ||
        (lower.startsWith('void') && lower.includes('transaction'))
      );
    });
    expect(violations).toEqual([]);
  });

  it('TransferService prototype exposes no update or delete method for transactions', () => {
    const proto = TransferService.prototype as unknown as Record<string, unknown>;
    const keys = Object.getOwnPropertyNames(proto);
    const violations = keys.filter((k) => {
      const lower = k.toLowerCase();
      return (
        (lower.startsWith('update') && lower.includes('transaction')) ||
        (lower.startsWith('delete') && lower.includes('transaction')) ||
        (lower.startsWith('patch') && lower.includes('transaction')) ||
        (lower.startsWith('void') && lower.includes('transaction'))
      );
    });
    expect(violations).toEqual([]);
  });
});

// ── 5. fds.inventory.low NOT emitted when threshold not crossed ──────

describe('InventoryService — fds.inventory.low emit gating', () => {
  it('RECEIPT that lands above threshold does not emit fds.inventory.low', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM fds_inventory_levels l') &&
        call.sql.includes('JOIN fds_inventory_groups g') &&
        call.sql.includes('JOIN fds_inventory_items i')
      ) {
        // Prior on-hand 50, threshold 30
        return [
          {
            id: 'l1',
            quantity_on_hand: 50,
            reorder_threshold: 30,
            item_name: 'Chicken',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (call.sql.includes('FROM fds_inventory_transactions WHERE id')) {
        return [
          {
            id: 't1',
            group_id: 'g1',
            item_id: 'i1',
            transaction_type: 'RECEIPT',
            quantity_delta: 10,
            performed_by: ADMIN_ACTOR.accountId,
            transaction_at: new Date(),
            transfer_reference_id: null,
            related_session_id: null,
            notes: null,
          },
        ];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const { outbox, enqueued } = makeOutbox();
    const svc = new InventoryService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    void kafka;
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.receive({ groupId: 'g1', itemId: 'i1', quantity: 10 }, ADMIN_ACTOR),
    );
    // After RECEIPT new on-hand = 60, still above 30 — no outbox enqueue.
    const lows = enqueued.filter((e) => e.topic === 'fds.inventory.low');
    expect(lows).toEqual([]);
  });
});

// ── 6. fds.inventory.low IS emitted when USAGE crosses downward ──────

describe('InventoryService — USAGE crossing reorder_threshold downward', () => {
  it('emits fds.inventory.low with ADR-057 envelope shape', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM fds_inventory_levels l') &&
        call.sql.includes('JOIN fds_inventory_groups g') &&
        call.sql.includes('JOIN fds_inventory_items i')
      ) {
        return [
          {
            id: 'l1',
            quantity_on_hand: 35,
            reorder_threshold: 30,
            item_name: 'Chicken breast (boneless)',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (call.sql.includes('FROM fds_inventory_transactions WHERE id')) {
        return [
          {
            id: 't1',
            group_id: 'g1',
            item_id: 'i1',
            transaction_type: 'USAGE',
            quantity_delta: -10,
            performed_by: ADMIN_ACTOR.accountId,
            transaction_at: new Date(),
            transfer_reference_id: null,
            related_session_id: null,
            notes: null,
          },
        ];
      }
      return [];
    });
    const { kafka } = makeKafka();
    // REVIEW-P2-10a ROUND 1 BLOCKING 3 — assertion switched from
    // KafkaProducerService.emit (best-effort, post-commit) to the
    // OutboxService.enqueueInTx call inside the same tenant tx.
    const { outbox, enqueued } = makeOutbox();
    const svc = new InventoryService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    void kafka;
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.usage({ groupId: 'g1', itemId: 'i1', quantity: 10 }, ADMIN_ACTOR),
    );
    // Prior 35, after -10 = 25; threshold 30; crossed downward —
    // outbox enqueue fired.
    const lows = enqueued.filter((e) => e.topic === 'fds.inventory.low');
    expect(lows).toHaveLength(1);
    expect(lows[0]!.sourceModule).toBe('food-service');
    expect(lows[0]!.key).toBe('i1');
    // Deterministic event_id v5-shape, keyed on transactionId.
    expect(lows[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(lows[0]!.payload).toMatchObject({
      schoolId: SCHOOL.schoolId,
      groupId: 'g1',
      itemId: 'i1',
      itemName: 'Chicken breast (boneless)',
      previousQuantity: 35,
      newQuantity: 25,
      reorderThreshold: 30,
    });
  });
});

// ── 7. TransferService.complete writes paired TRANSFER_OUT + IN ─────

describe('TransferService.complete — paired transactions + shared ref', () => {
  it('writes 2 inventory transactions with shared transfer_reference_id', async () => {
    const inserts: Array<{ sql: string; args: unknown[] }> = [];
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM fds_inventory_transfer_requests WHERE id') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [
          {
            status: 'APPROVED',
            from_group_id: 'g1',
            to_group_id: 'g2',
            item_id: 'i1',
            quantity: 5.0,
          },
        ];
      }
      if (call.sql.includes('FROM fds_inventory_levels WHERE group_id')) {
        // First call: from-group (with stock), second call: to-group
        // (return empty so we hit the insert path).
        if (call.args[0] === 'g1') return [{ id: 'lFrom', quantity_on_hand: 20.0 }];
        return [];
      }
      if (call.sql.includes('INSERT INTO fds_inventory_transactions') && call.fn === 'e') {
        inserts.push({ sql: call.sql, args: call.args });
      }
      if (call.sql.includes('SELECT id::text AS id, school_id::text AS school_id, from_group_id')) {
        return [
          {
            id: 'tr1',
            school_id: SCHOOL.schoolId,
            from_group_id: 'g1',
            to_group_id: 'g2',
            item_id: 'i1',
            quantity: 5.0,
            reason: null,
            status: 'COMPLETED',
            requested_by: ADMIN_ACTOR.accountId,
            reviewed_by: ADMIN_ACTOR.accountId,
            reviewed_at: new Date(),
            completed_at: new Date(),
            transfer_reference_id: 'shared-ref-uuid',
            created_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new TransferService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.complete('tr1', ADMIN_ACTOR));
    expect(inserts).toHaveLength(2);
    // Both inserts share transfer_reference_id (positional arg 7).
    const ref1 = inserts[0]!.args[6] as string;
    const ref2 = inserts[1]!.args[6] as string;
    expect(ref1).toEqual(ref2);
    expect(typeof ref1).toBe('string');
    expect(ref1.length).toBeGreaterThan(0);
    // First insert is TRANSFER_OUT (negative delta).
    expect(inserts[0]!.sql).toContain("'TRANSFER_OUT'");
    expect(inserts[0]!.args[4]).toBe(-5.0);
    // Second insert is TRANSFER_IN (positive delta).
    expect(inserts[1]!.sql).toContain("'TRANSFER_IN'");
    expect(inserts[1]!.args[4]).toBe(5.0);
  });

  it('refuses non-APPROVED transitions', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM fds_inventory_transfer_requests WHERE id') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [
          {
            status: 'PENDING',
            from_group_id: 'g1',
            to_group_id: 'g2',
            item_id: 'i1',
            quantity: 5.0,
          },
        ];
      }
      return [];
    });
    const svc = new TransferService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.complete('tr1', ADMIN_ACTOR)),
    ).rejects.toThrow(BadRequestException);
  });
});

// ── 9. StaffMealService.charge — PREPAID overdraw ───────────────────

describe('StaffMealService.charge', () => {
  it('refuses PREPAID overdraw with friendly 400', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM fds_staff_meal_accounts WHERE id') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [{ balance: 3.0, deduction_method: 'PREPAID', daily_limit: null }];
      }
      return [];
    });
    const svc = new StaffMealService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.charge('a1', { amount: 5.0 }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('no-ops balance on COMPLIMENTARY accounts (UPDATE only bumps updated_at)', async () => {
    let balanceUpdate: CapturedCall | undefined;
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM fds_staff_meal_accounts WHERE id') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [{ balance: 0.0, deduction_method: 'COMPLIMENTARY', daily_limit: null }];
      }
      if (call.sql.includes('UPDATE fds_staff_meal_accounts SET') && call.sql.includes('balance')) {
        balanceUpdate = call;
      }
      return [];
    });
    const svc = new StaffMealService(fake.tenantPrisma as never, makePermCheck() as never);
    // For getById final read after charge:
    fake.client.$queryRawUnsafe = (async (sql: string, ...args: unknown[]) => {
      if (sql.includes('FROM fds_staff_meal_accounts WHERE id') && sql.includes('FOR UPDATE')) {
        return [{ balance: 0.0, deduction_method: 'COMPLIMENTARY', daily_limit: null }];
      }
      if (sql.includes('SELECT id::text AS id, employee_id::text AS employee_id')) {
        return [
          {
            id: 'a1',
            employee_id: 'e1',
            school_id: SCHOOL.schoolId,
            balance: 0.0,
            deduction_method: 'COMPLIMENTARY',
            daily_limit: null,
          },
        ];
      }
      return [];
    }) as never;
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.charge('a1', { amount: 5.0 }, ADMIN_ACTOR),
    );
    // Balance UPDATE never fires for COMPLIMENTARY — only an updated_at
    // bump. balanceUpdate is undefined or has only updated_at touched.
    expect(balanceUpdate).toBeUndefined();
  });

  it('refuses charge exceeding daily_limit', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM fds_staff_meal_accounts WHERE id') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [{ balance: 100.0, deduction_method: 'PAYROLL', daily_limit: 8.0 }];
      }
      return [];
    });
    const svc = new StaffMealService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.charge('a1', { amount: 20.0 }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/daily limit/i);
  });
});

// ── 11. Permission gates — non-admin non-staff actors refused ────────

describe('P2-10a permission gates', () => {
  it('RecipeService refuses STUDENT actor at assertCanManage', async () => {
    // REVIEW-P2-10a ROUND 1 BLOCKING 4 — STUDENT does not hold
    // FDS-006:write so the permission-check stub returns false; the
    // service throws Forbidden.
    const fake = makeFake(() => []);
    const svc = new RecipeService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ name: 'X', category: 'ENTREE', servingYield: 1 }, STUDENT_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('InventoryService refuses STUDENT actor at assertCanManage', async () => {
    const fake = makeFake(() => []);
    const { kafka } = makeKafka();
    const outbox = makeOutbox().outbox;
    const svc = new InventoryService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck({ allow: false }) as never,
    );
    void kafka;
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.receive({ groupId: 'g1', itemId: 'i1', quantity: 1 }, STUDENT_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('TransferService refuses STUDENT actor at assertCanManage', async () => {
    const fake = makeFake(() => []);
    const svc = new TransferService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          { fromGroupId: 'g1', toGroupId: 'g2', itemId: 'i1', quantity: 1 },
          STUDENT_ACTOR,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('StaffMealService refuses STUDENT actor at assertCanManage', async () => {
    const fake = makeFake(() => []);
    const svc = new StaffMealService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ employeeId: 'e1' }, STUDENT_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('STAFF actor passes assertCanManage on InventoryService.receive', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM fds_inventory_levels l') &&
        call.sql.includes('JOIN fds_inventory_groups g') &&
        call.sql.includes('JOIN fds_inventory_items i')
      ) {
        return [
          {
            id: 'l1',
            quantity_on_hand: 10,
            reorder_threshold: null,
            item_name: 'X',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (call.sql.includes('FROM fds_inventory_transactions WHERE id')) {
        return [
          {
            id: 't1',
            group_id: 'g1',
            item_id: 'i1',
            transaction_type: 'RECEIPT',
            quantity_delta: 5,
            performed_by: STAFF_ACTOR.accountId,
            transaction_at: new Date(),
            transfer_reference_id: null,
            related_session_id: null,
            notes: null,
          },
        ];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const outbox = makeOutbox().outbox;
    const svc = new InventoryService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    void kafka;
    // Should not throw.
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.receive({ groupId: 'g1', itemId: 'i1', quantity: 5 }, STAFF_ACTOR),
    );
    expect(dto.transactionType).toBe('RECEIPT');
  });
});

// ── 12. Controller route metadata — FDS-003 / FDS-004 permissions ────

describe('FoodServiceAdvancedController — @RequirePermission metadata', () => {
  it('uses fds-003 for recipe routes, fds-004 for inventory/transfer/staff-meal routes, and fds-005 for preorder routes', async () => {
    // Import the controller and inspect the prototype methods for the
    // RequirePermission decorator metadata. The decorator stores its
    // value on the metadata key 'requiredPermissions'.
    const { FoodServiceAdvancedController } = await import('./food-service-advanced.controller');
    const proto = FoodServiceAdvancedController.prototype;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (m) =>
        m !== 'constructor' &&
        typeof (proto as unknown as Record<string, unknown>)[m] === 'function',
    );
    expect(methods.length).toBeGreaterThan(20);
    // P2-10a + P2-10b range: fds-003 / fds-004 / fds-005 covering recipe,
    // inventory, transfer, staff-meal, and preorder routes.
    for (const m of methods) {
      const perms = Reflect.getMetadata(
        'requiredPermissions',
        proto[m as keyof typeof proto] as object,
      ) as string[] | undefined;
      expect(perms, 'method ' + m + ' missing @RequirePermission').toBeDefined();
      expect(perms!.length).toBeGreaterThan(0);
      for (const p of perms!) {
        expect(p).toMatch(/^fds-(003|004|005):(read|write|admin)$/);
      }
    }
  });
});

// ── 13. NotFoundException propagation ─────────────────────────────────

describe('Recipe/Transfer/StaffMeal NotFoundException propagation', () => {
  it('RecipeService.getById throws NotFoundException for missing id', async () => {
    const fake = makeFake(() => []);
    const svc = new RecipeService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.getById('missing')),
    ).rejects.toThrow(NotFoundException);
  });

  it('TransferService.getById throws NotFoundException for missing id', async () => {
    const fake = makeFake(() => []);
    const svc = new TransferService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.getById('missing')),
    ).rejects.toThrow(NotFoundException);
  });

  it('StaffMealService.getByEmployee throws NotFoundException for missing employee', async () => {
    const fake = makeFake(() => []);
    const svc = new StaffMealService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.getByEmployee('missing')),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─── P2-10b PreorderService specs ────────────────────────────────────

import { ConflictException } from '@nestjs/common';
import { PreorderService } from './preorder.service';

const GUARDIAN_ACTOR = {
  accountId: '019e0cf8-aaaa-7000-aaaa-000000000004',
  personId: '019e0cf8-aaaa-7000-aaaa-000000000040',
  personType: 'GUARDIAN',
  isSchoolAdmin: false,
  employeeId: null,
} as never;

const STUDENT_OWN_PERSON = '019e0cf8-aaaa-7000-aaaa-000000000030';
const STUDENT_OWN = {
  accountId: '019e0cf8-aaaa-7000-aaaa-000000000005',
  personId: STUDENT_OWN_PERSON,
  personType: 'STUDENT',
  isSchoolAdmin: false,
  employeeId: null,
} as never;

const OPEN_WINDOW = {
  id: 'w1',
  school_id: SCHOOL.schoolId,
  service_date: new Date('2026-05-20'),
  meal_type: 'LUNCH',
  opens_at: new Date(Date.now() - 60 * 60 * 1000),
  closes_at: new Date(Date.now() + 60 * 60 * 1000),
};
const CLOSED_WINDOW = {
  id: 'w2',
  school_id: SCHOOL.schoolId,
  service_date: new Date('2026-05-20'),
  meal_type: 'LUNCH',
  opens_at: new Date(Date.now() + 60 * 60 * 1000),
  closes_at: new Date(Date.now() + 4 * 60 * 60 * 1000),
};

const MENU_ITEMS_CLEAN = [
  {
    id: 'mi1',
    name: 'Veggie Pasta',
    allergen_codes: ['WHEAT'],
    is_active: true,
    is_preorderable: true,
  },
  { id: 'mi2', name: 'Fruit Cup', allergen_codes: [], is_active: true, is_preorderable: true },
];

const MENU_ITEMS_WITH_PEANUTS = [
  {
    id: 'mi3',
    name: 'Peanut Sauce Noodles',
    allergen_codes: ['PEANUT'],
    is_active: true,
    is_preorderable: true,
  },
];

// 14. Allergen cross-check KEYSTONE — CRITICAL severity blocks the order
describe('PreorderService — allergen cross-check (KEYSTONE)', () => {
  it('CRITICAL severity match BLOCKS the order with ConflictException', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_preorder_windows WHERE id') && call.sql.includes('LIMIT 1')) {
        return [OPEN_WINDOW];
      }
      if (call.sql.includes('SELECT 1 AS ok FROM sis_student_guardians sg')) {
        return [{ ok: 1 }]; // guardian linked to student
      }
      if (call.sql.includes('FROM fds_menu_items WHERE school_id')) {
        return MENU_ITEMS_WITH_PEANUTS;
      }
      if (call.sql.includes('FROM fds_student_allergen_alerts')) {
        return [{ allergen_code: 'PEANUT', severity: 'CRITICAL' }];
      }
      return [];
    });
    // REVIEW-P2C10 ROUND 2 BLOCKING 3 — GUARDIAN does NOT hold
    // fds-006:write, so the FSM admin path is not taken. The
    // GUARDIAN branch runs the linked-child check and proceeds
    // to the allergen cross-check.
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPreorder(
          {
            studentId: 's1',
            preorderWindowId: 'w1',
            items: [{ menuItemId: 'mi3', quantity: 1 }],
          },
          GUARDIAN_ACTOR,
        ),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('WARNING severity match surfaces in warning_allergens but the order persists', async () => {
    let insertedWarnings: string[] | undefined;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_preorder_windows WHERE id') && call.sql.includes('LIMIT 1')) {
        return [OPEN_WINDOW];
      }
      if (call.sql.includes('SELECT 1 AS ok FROM sis_student_guardians sg')) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('FROM fds_menu_items WHERE school_id')) {
        return MENU_ITEMS_CLEAN;
      }
      if (call.sql.includes('FROM fds_student_allergen_alerts')) {
        return [{ allergen_code: 'WHEAT', severity: 'WARNING' }];
      }
      if (call.sql.includes('INSERT INTO fds_meal_preorders')) {
        // The warning_allergens column is the 7th positional arg
        // (id, school_id, student_id, preorder_window_id, ordered_by,
        // [warning_allergens]).
        insertedWarnings = call.args[5] as string[];
      }
      if (call.sql.includes('SELECT p.id::text AS id, p.school_id::text')) {
        return [
          {
            id: 'p1',
            school_id: SCHOOL.schoolId,
            student_id: 's1',
            preorder_window_id: 'w1',
            ordered_by: GUARDIAN_ACTOR.accountId,
            status: 'PENDING',
            allergen_check_passed: true,
            blocking_allergens: [],
            warning_allergens: ['WHEAT'],
            confirmed_at: null,
            cancelled_at: null,
            cancellation_reason: null,
            notes: null,
            created_at: new Date(),
            window_service_date: OPEN_WINDOW.service_date,
            window_meal_type: OPEN_WINDOW.meal_type,
            student_name: null,
          },
        ];
      }
      return [];
    });
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.createPreorder(
        {
          studentId: 's1',
          preorderWindowId: 'w1',
          items: [{ menuItemId: 'mi1', quantity: 1 }],
        },
        GUARDIAN_ACTOR,
      ),
    );
    expect(insertedWarnings).toEqual(['WHEAT']);
    expect(result.warningAllergens).toEqual(['WHEAT']);
    expect(result.allergenCheckPassed).toBe(true);
  });

  it('no allergen match → order persists with allergen_check_passed=true and empty warning_allergens', async () => {
    let insertedWarnings: string[] | undefined;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_preorder_windows WHERE id') && call.sql.includes('LIMIT 1')) {
        return [OPEN_WINDOW];
      }
      if (call.sql.includes('SELECT 1 AS ok FROM sis_student_guardians sg')) return [{ ok: 1 }];
      if (call.sql.includes('FROM fds_menu_items WHERE school_id')) return MENU_ITEMS_CLEAN;
      if (call.sql.includes('FROM fds_student_allergen_alerts')) return [];
      if (call.sql.includes('INSERT INTO fds_meal_preorders')) {
        insertedWarnings = call.args[5] as string[];
      }
      if (call.sql.includes('SELECT p.id::text AS id, p.school_id::text')) {
        return [
          {
            id: 'p1',
            school_id: SCHOOL.schoolId,
            student_id: 's1',
            preorder_window_id: 'w1',
            ordered_by: GUARDIAN_ACTOR.accountId,
            status: 'PENDING',
            allergen_check_passed: true,
            blocking_allergens: [],
            warning_allergens: [],
            confirmed_at: null,
            cancelled_at: null,
            cancellation_reason: null,
            notes: null,
            created_at: new Date(),
            window_service_date: OPEN_WINDOW.service_date,
            window_meal_type: OPEN_WINDOW.meal_type,
            student_name: null,
          },
        ];
      }
      return [];
    });
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.createPreorder(
        {
          studentId: 's1',
          preorderWindowId: 'w1',
          items: [{ menuItemId: 'mi1', quantity: 1 }],
        },
        GUARDIAN_ACTOR,
      ),
    );
    expect(insertedWarnings).toEqual([]);
    expect(result.allergenCheckPassed).toBe(true);
    expect(result.warningAllergens).toEqual([]);
  });
});

// 15. Window gate — closed window refuses non-admin orders
describe('PreorderService — window gate', () => {
  it('refuses orders against a window that has not yet opened (non-admin)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_preorder_windows WHERE id')) return [CLOSED_WINDOW];
      if (call.sql.includes('SELECT 1 AS ok FROM sis_student_guardians sg')) return [{ ok: 1 }];
      return [];
    });
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPreorder(
          {
            studentId: 's1',
            preorderWindowId: 'w2',
            items: [{ menuItemId: 'mi1', quantity: 1 }],
          },
          GUARDIAN_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('admin bypasses the window gate', async () => {
    let insertedSlot = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_preorder_windows WHERE id')) return [CLOSED_WINDOW];
      // REVIEW-P2C10 ROUND 2 BLOCKING 2 — even the admin path
      // validates the studentId against the current tenant. The
      // mock returns a row so the validation passes.
      if (
        call.sql.includes('SELECT 1 AS ok FROM sis_students WHERE school_id') &&
        call.sql.includes('AND id =')
      ) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('FROM fds_menu_items WHERE school_id')) return MENU_ITEMS_CLEAN;
      if (call.sql.includes('FROM fds_student_allergen_alerts')) return [];
      if (call.sql.includes('INSERT INTO fds_meal_preorders')) insertedSlot = true;
      if (call.sql.includes('SELECT p.id::text AS id, p.school_id::text')) {
        return [
          {
            id: 'p1',
            school_id: SCHOOL.schoolId,
            student_id: 's1',
            preorder_window_id: 'w2',
            ordered_by: ADMIN_ACTOR.accountId,
            status: 'PENDING',
            allergen_check_passed: true,
            blocking_allergens: [],
            warning_allergens: [],
            confirmed_at: null,
            cancelled_at: null,
            cancellation_reason: null,
            notes: null,
            created_at: new Date(),
            window_service_date: CLOSED_WINDOW.service_date,
            window_meal_type: CLOSED_WINDOW.meal_type,
            student_name: null,
          },
        ];
      }
      return [];
    });
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.createPreorder(
        {
          studentId: 's1',
          preorderWindowId: 'w2',
          items: [{ menuItemId: 'mi1', quantity: 1 }],
        },
        ADMIN_ACTOR,
      ),
    );
    expect(insertedSlot).toBe(true);
  });
});

// 16. Cross-student row-scope — STUDENT cannot order for another student
describe('PreorderService — student row-scope', () => {
  it('STUDENT attempting to order for someone other than self is refused 403', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_preorder_windows WHERE id')) return [OPEN_WINDOW];
      if (call.sql.includes('FROM sis_students s')) return []; // mismatch — student isn't this one
      return [];
    });
    // REVIEW-P2C10 ROUND 2 BLOCKING 3 — STUDENT does not hold
    // fds-006:write, so the FSM admin path is not taken.
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPreorder(
          {
            studentId: 'someone-else',
            preorderWindowId: 'w1',
            items: [{ menuItemId: 'mi1', quantity: 1 }],
          },
          STUDENT_OWN,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('GUARDIAN attempting to order for non-linked child is refused 403', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_preorder_windows WHERE id')) return [OPEN_WINDOW];
      if (call.sql.includes('SELECT 1 AS ok FROM sis_student_guardians sg')) return []; // not linked
      return [];
    });
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPreorder(
          {
            studentId: 'unlinked-child',
            preorderWindowId: 'w1',
            items: [{ menuItemId: 'mi1', quantity: 1 }],
          },
          GUARDIAN_ACTOR,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

// 17. Confirm path refuses CANCELLED + cannot-confirm-when-allergen-check-failed
describe('PreorderService.confirmPreorder', () => {
  it('refuses confirming a CANCELLED preorder', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT status, allergen_check_passed FROM fds_meal_preorders')) {
        return [{ status: 'CANCELLED', allergen_check_passed: true }];
      }
      return [];
    });
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.confirmPreorder('p1', ADMIN_ACTOR)),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses confirming when allergen_check_passed=false (defensive)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT status, allergen_check_passed FROM fds_meal_preorders')) {
        return [{ status: 'PENDING', allergen_check_passed: false }];
      }
      return [];
    });
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.confirmPreorder('p1', ADMIN_ACTOR)),
    ).rejects.toThrow(BadRequestException);
  });

  it('non-admin non-staff cannot confirm', async () => {
    // REVIEW-P2C10 ROUND 2 BLOCKING 3 — guardian without fds-006:write
    // is rejected at the FSM admin gate.
    const fake = makeFake(() => []);
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.confirmPreorder('p1', GUARDIAN_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

// 18. Window create with reversed window throws 400
describe('PreorderService.createWindow', () => {
  it('rejects closesAt <= opensAt', async () => {
    const fake = makeFake(() => []);
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createWindow(
          {
            serviceDate: '2026-06-01',
            mealType: 'LUNCH',
            opensAt: '2026-06-01T08:00:00Z',
            closesAt: '2026-06-01T08:00:00Z',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('non-admin non-staff cannot create windows', async () => {
    // REVIEW-P2C10 ROUND 2 BLOCKING 3 — guardian without fds-006:write
    // is rejected at the FSM admin gate.
    const fake = makeFake(() => []);
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createWindow(
          {
            serviceDate: '2026-06-01',
            mealType: 'LUNCH',
            opensAt: '2026-06-01T07:00:00Z',
            closesAt: '2026-06-01T09:00:00Z',
          },
          GUARDIAN_ACTOR,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

// 19. Cancel preorder owner / admin / row-scope path
describe('PreorderService.cancelPreorder', () => {
  it('admin can cancel any preorder', async () => {
    let updateRan = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT status, ordered_by::text AS ordered_by')) {
        return [{ status: 'PENDING', ordered_by: GUARDIAN_ACTOR.accountId, student_id: 's1' }];
      }
      if (call.sql.includes('UPDATE fds_meal_preorders SET')) updateRan = true;
      if (call.sql.includes('SELECT p.id::text AS id, p.school_id::text')) {
        return [
          {
            id: 'p1',
            school_id: SCHOOL.schoolId,
            student_id: 's1',
            preorder_window_id: 'w1',
            ordered_by: GUARDIAN_ACTOR.accountId,
            status: 'CANCELLED',
            allergen_check_passed: true,
            blocking_allergens: [],
            warning_allergens: [],
            confirmed_at: null,
            cancelled_at: new Date(),
            cancellation_reason: 'Plans changed',
            notes: null,
            created_at: new Date(),
            window_service_date: OPEN_WINDOW.service_date,
            window_meal_type: OPEN_WINDOW.meal_type,
            student_name: null,
          },
        ];
      }
      return [];
    });
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.cancelPreorder('p1', { reason: 'Plans changed' }, ADMIN_ACTOR),
    );
    expect(updateRan).toBe(true);
    expect(result.status).toBe('CANCELLED');
  });

  it('already CANCELLED is a no-op', async () => {
    let updateRan = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT status, ordered_by::text AS ordered_by')) {
        return [{ status: 'CANCELLED', ordered_by: GUARDIAN_ACTOR.accountId, student_id: 's1' }];
      }
      if (call.sql.includes('UPDATE fds_meal_preorders SET')) updateRan = true;
      if (call.sql.includes('SELECT p.id::text AS id, p.school_id::text')) {
        return [
          {
            id: 'p1',
            school_id: SCHOOL.schoolId,
            student_id: 's1',
            preorder_window_id: 'w1',
            ordered_by: GUARDIAN_ACTOR.accountId,
            status: 'CANCELLED',
            allergen_check_passed: true,
            blocking_allergens: [],
            warning_allergens: [],
            confirmed_at: null,
            cancelled_at: new Date(),
            cancellation_reason: null,
            notes: null,
            created_at: new Date(),
            window_service_date: OPEN_WINDOW.service_date,
            window_meal_type: OPEN_WINDOW.meal_type,
            student_name: null,
          },
        ];
      }
      return [];
    });
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.cancelPreorder('p1', {}, ADMIN_ACTOR),
    );
    expect(updateRan).toBe(false);
  });
});

// 20. Validation — at least 1 item, bogus menu_item_id refused
describe('PreorderService input validation', () => {
  it('refuses an empty items array', async () => {
    const fake = makeFake(() => []);
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPreorder({ studentId: 's1', preorderWindowId: 'w1', items: [] }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a menuItemId that does not match any current-tenant fds_menu_items row', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_preorder_windows WHERE id')) return [OPEN_WINDOW];
      if (call.sql.includes('FROM fds_menu_items WHERE school_id')) return []; // no match
      return [];
    });
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPreorder(
          {
            studentId: 's1',
            preorderWindowId: 'w1',
            items: [{ menuItemId: 'bogus', quantity: 1 }],
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

// 21. Production report regen UPSERT — verify ON CONFLICT path is exercised
describe('PreorderService.generateProductionReport', () => {
  it('non-admin non-staff cannot generate the production report', async () => {
    // REVIEW-P2C10 ROUND 2 BLOCKING 3 — guardian without fds-006:write
    // is rejected at the FSM admin gate.
    const fake = makeFake(() => []);
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.generateProductionReport(
          { serviceDate: '2026-06-01', mealType: 'LUNCH' },
          GUARDIAN_ACTOR,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('UPSERT uses ON CONFLICT so regeneration replaces in place', async () => {
    let insertSql: string | undefined;
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT mi.id::text AS menu_item_id, mi.name AS menu_item_name')) {
        return [
          {
            menu_item_id: 'mi1',
            menu_item_name: 'Veggie Pasta',
            total_quantity: 3,
            order_count: 3,
          },
        ];
      }
      if (call.sql.includes('SELECT UNNEST(mi.allergen_codes) AS allergen')) {
        return [{ allergen: 'WHEAT', affected_orders: 3 }];
      }
      if (
        call.sql.includes("WHERE p.school_id = $1::uuid AND p.status = 'CONFIRMED'") &&
        call.sql.includes('COUNT(*)')
      ) {
        return [{ n: 3 }];
      }
      if (call.sql.includes('INSERT INTO fds_preorder_production_reports')) {
        insertSql = call.sql;
      }
      if (
        call.sql.includes(
          'SELECT id::text AS id, school_id::text AS school_id, service_date, meal_type, total_orders',
        )
      ) {
        return [
          {
            id: 'rep1',
            school_id: SCHOOL.schoolId,
            service_date: new Date('2026-06-01'),
            meal_type: 'LUNCH',
            total_orders: 3,
            total_items: 3,
            report_data: {
              itemBreakdown: [
                {
                  menuItemId: 'mi1',
                  menuItemName: 'Veggie Pasta',
                  totalQuantity: 3,
                  orderCount: 3,
                },
              ],
              dietaryBreakdown: [{ allergen: 'WHEAT', affectedOrders: 3 }],
            },
            generated_by: ADMIN_ACTOR.accountId,
            generated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.generateProductionReport({ serviceDate: '2026-06-01', mealType: 'LUNCH' }, ADMIN_ACTOR),
    );
    expect(insertSql).toContain('ON CONFLICT (school_id, service_date, meal_type) DO UPDATE');
    expect(result.totalOrders).toBe(3);
    expect(result.itemBreakdown[0]!.menuItemName).toBe('Veggie Pasta');
    expect(result.dietaryBreakdown[0]!.allergen).toBe('WHEAT');
  });
});

// ─── REVIEW-P2-10a ROUND 1 fixes ─────────────────────────────────────

describe('REVIEW-P2-10a ROUND 1 — BLOCKING 1 recipe ingredient school-scope', () => {
  it('addIngredient lock includes school_id predicate', async () => {
    const capturedSql: string[] = [];
    const fake = makeFake((call) => {
      capturedSql.push(call.sql);
      if (call.sql.includes('FROM fds_recipes WHERE id') && call.sql.includes('FOR UPDATE')) {
        return [{ id: 'r1', school_id: SCHOOL.schoolId, serving_yield: 100 }];
      }
      if (call.sql.includes('FROM fds_recipe_ingredients WHERE recipe_id')) {
        return [];
      }
      if (call.sql.includes('SELECT serving_yield FROM fds_recipes')) {
        return [{ serving_yield: 100 }];
      }
      if (call.sql.includes('FROM fds_recipes WHERE id') && call.sql.includes('school_id')) {
        return [
          {
            id: 'r1',
            school_id: SCHOOL.schoolId,
            name: 'X',
            category: 'ENTREE',
            serving_yield: 100,
            prep_time_minutes: null,
            cook_time_minutes: null,
            instructions: null,
            allergens: [],
            cost_per_serving: null,
            menu_item_id: null,
            is_active: true,
            created_by: ADMIN_ACTOR.accountId,
            created_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new RecipeService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.addIngredient(
        'r1',
        { ingredientName: 'New', quantity: 1, unit: 'lb', allergens: [], unitCost: 1.5 },
        ADMIN_ACTOR,
      ),
    );
    const lockSql = capturedSql.find(
      (s) => s.includes('FROM fds_recipes WHERE id') && s.includes('FOR UPDATE'),
    );
    expect(lockSql).toBeDefined();
    expect(lockSql).toMatch(/WHERE id = \$1::uuid AND school_id = \$2::uuid/);
  });

  it('addIngredient with cross-school inventoryItemId is refused with 400', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_recipes WHERE id') && call.sql.includes('FOR UPDATE')) {
        return [{ id: 'r1', school_id: SCHOOL.schoolId, serving_yield: 100 }];
      }
      if (
        call.sql.includes('FROM fds_inventory_items WHERE id') &&
        call.sql.includes('school_id')
      ) {
        return []; // No match — cross-school inventoryItemId
      }
      return [];
    });
    const svc = new RecipeService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.addIngredient(
          'r1',
          {
            ingredientName: 'Cross-school',
            quantity: 1,
            unit: 'lb',
            allergens: [],
            unitCost: 1.0,
            inventoryItemId: '019e0cf8-bbbb-7000-bbbb-000000000099',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('updateIngredient JOIN includes r.school_id predicate', async () => {
    const capturedSql: string[] = [];
    const fake = makeFake((call) => {
      capturedSql.push(call.sql);
      return [];
    });
    const svc = new RecipeService(fake.tenantPrisma as never, makePermCheck() as never);
    // ingredient not found → throws, but the JOIN SQL is captured.
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.updateIngredient('bogus', { ingredientName: 'X' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(NotFoundException);
    const joinSql = capturedSql.find(
      (s) =>
        s.includes('FROM fds_recipe_ingredients i') &&
        s.includes('JOIN fds_recipes r ON r.id = i.recipe_id'),
    );
    expect(joinSql).toBeDefined();
    expect(joinSql).toContain('AND r.school_id = $2::uuid');
  });
});

describe('REVIEW-P2-10a ROUND 1 — BLOCKING 2 inventory existing-level school-scope', () => {
  it('movement existing-level lock SQL JOINs both groups and items with school predicates', async () => {
    const capturedSql: string[] = [];
    const fake = makeFake((call) => {
      capturedSql.push(call.sql);
      // Return no row so we exercise the new-level "verify" path. The
      // SQL capture from the FIRST query (the existing-level lock) is
      // what we're asserting on.
      if (call.sql.includes('FROM fds_inventory_items i JOIN fds_inventory_groups g')) {
        return [{ name: 'X', reorder_threshold: null, school_id: SCHOOL.schoolId }];
      }
      if (call.sql.includes('FROM fds_inventory_transactions WHERE id')) {
        return [
          {
            id: 't1',
            group_id: 'g1',
            item_id: 'i1',
            transaction_type: 'RECEIPT',
            quantity_delta: 1,
            performed_by: ADMIN_ACTOR.accountId,
            transaction_at: new Date(),
            transfer_reference_id: null,
            related_session_id: null,
            notes: null,
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new InventoryService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.receive({ groupId: 'g1', itemId: 'i1', quantity: 1 }, ADMIN_ACTOR),
    );
    const lockSql = capturedSql.find(
      (s) => s.includes('FROM fds_inventory_levels l') && s.includes('FOR UPDATE OF l'),
    );
    expect(lockSql).toBeDefined();
    expect(lockSql).toContain('JOIN fds_inventory_groups g ON g.id = l.group_id');
    expect(lockSql).toContain('JOIN fds_inventory_items i ON i.id = l.item_id');
    expect(lockSql).toContain('g.school_id = $3::uuid');
    expect(lockSql).toContain('i.school_id = $3::uuid');
  });
});

describe('REVIEW-P2-10a ROUND 1 — BLOCKING 3 fds.inventory.low durable outbox', () => {
  it('deterministicInventoryLowEventId is stable + v5-shaped', async () => {
    const { deterministicInventoryLowEventId } = await import('./inventory.service');
    const id1 = deterministicInventoryLowEventId('019e0cf8-aaaa-7000-aaaa-000000000abc');
    const id2 = deterministicInventoryLowEventId('019e0cf8-aaaa-7000-aaaa-000000000abc');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Different transaction id → different event id.
    const id3 = deterministicInventoryLowEventId('019e0cf8-aaaa-7000-aaaa-000000000def');
    expect(id3).not.toBe(id1);
  });

  it('emit is enqueued via outbox.enqueueInTx INSIDE the tenant tx, never via kafka.emit', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM fds_inventory_levels l') &&
        call.sql.includes('JOIN fds_inventory_groups g') &&
        call.sql.includes('JOIN fds_inventory_items i')
      ) {
        return [
          {
            id: 'l1',
            quantity_on_hand: 35,
            reorder_threshold: 30,
            item_name: 'Chicken',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (call.sql.includes('FROM fds_inventory_transactions WHERE id')) {
        return [
          {
            id: 't1',
            group_id: 'g1',
            item_id: 'i1',
            transaction_type: 'USAGE',
            quantity_delta: -10,
            performed_by: ADMIN_ACTOR.accountId,
            transaction_at: new Date(),
            transfer_reference_id: null,
            related_session_id: null,
            notes: null,
          },
        ];
      }
      return [];
    });
    const { kafka, emitted } = makeKafka();
    const { outbox, enqueued } = makeOutbox();
    const svc = new InventoryService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    void kafka;
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.usage({ groupId: 'g1', itemId: 'i1', quantity: 10 }, ADMIN_ACTOR),
    );
    // BLOCKING 3 contract — emit via outbox, not via best-effort kafka.
    expect(emitted).toEqual([]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('fds.inventory.low');
    expect(enqueued[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('REVIEW-P2-10a ROUND 1 — BLOCKING 4 generic STAFF refused without FDS-006', () => {
  it('generic STAFF without fds-006:write cannot mutate recipes', async () => {
    const fake = makeFake(() => []);
    const svc = new RecipeService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ name: 'X', category: 'ENTREE', servingYield: 1 }, STAFF_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('generic STAFF without fds-006:write cannot mutate inventory', async () => {
    const fake = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new InventoryService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.receive({ groupId: 'g1', itemId: 'i1', quantity: 1 }, STAFF_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('generic STAFF without fds-006:write cannot mutate transfers', async () => {
    const fake = makeFake(() => []);
    const svc = new TransferService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ fromGroupId: 'g1', toGroupId: 'g2', itemId: 'i1', quantity: 1 }, STAFF_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('generic STAFF without fds-006:write cannot mutate staff meal accounts', async () => {
    const fake = makeFake(() => []);
    const svc = new StaffMealService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ employeeId: 'e1' }, STAFF_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('REVIEW-P2-10a ROUND 1 — MAJOR 5 staff meal patch school-scope', () => {
  it('patch UPDATE includes school_id predicate', async () => {
    const capturedSql: string[] = [];
    const fake = makeFake((call) => {
      capturedSql.push(call.sql);
      if (call.sql.includes('UPDATE fds_staff_meal_accounts SET')) {
        return 1; // simulate 1 row updated
      }
      // Return a row for getById reload after patch.
      if (call.sql.includes('FROM fds_staff_meal_accounts')) {
        return [
          {
            id: 'a1',
            employee_id: 'e1',
            school_id: SCHOOL.schoolId,
            balance: 0,
            deduction_method: 'PAYROLL',
            daily_limit: null,
          },
        ];
      }
      return [];
    });
    const svc = new StaffMealService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.patch('a1', { deductionMethod: 'PREPAID' }, ADMIN_ACTOR),
    );
    const updateSql = capturedSql.find((s) => s.includes('UPDATE fds_staff_meal_accounts SET'));
    expect(updateSql).toBeDefined();
    expect(updateSql).toMatch(/AND school_id = \$\d+::uuid/);
  });
});

// ─── REVIEW-P2C10 ROUND 2 fixes ──────────────────────────────────────

describe('REVIEW-P2C10 ROUND 2 — BLOCKING 1 student/guardian school-scope', () => {
  it('STUDENT branch query includes s.school_id = $tenant.schoolId predicate', async () => {
    const capturedSql: string[] = [];
    const fake = makeFake((call) => {
      capturedSql.push(call.sql);
      if (call.sql.includes('FROM fds_preorder_windows WHERE id')) {
        return [
          {
            id: 'w1',
            school_id: SCHOOL.schoolId,
            service_date: new Date('2026-05-20'),
            meal_type: 'LUNCH',
            opens_at: new Date(Date.now() - 60 * 60 * 1000),
            closes_at: new Date(Date.now() + 60 * 60 * 1000),
          },
        ];
      }
      // No matching student row → STUDENT path 403s.
      return [];
    });
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPreorder(
          {
            studentId: 'cross-school-student',
            preorderWindowId: 'w1',
            items: [{ menuItemId: 'mi1', quantity: 1 }],
          },
          STUDENT_OWN,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
    // Assert the STUDENT branch SQL actually contains the new
    // s.school_id = $1::uuid + s.id = $2::uuid + ps.person_id = $3::uuid shape.
    const studentSql = capturedSql.find(
      (s) => s.includes('FROM sis_students s') && s.includes('JOIN platform.platform_students ps'),
    );
    expect(studentSql).toBeDefined();
    expect(studentSql).toContain('s.school_id = $1::uuid');
    expect(studentSql).toContain('s.id = $2::uuid');
    expect(studentSql).toContain('ps.person_id = $3::uuid');
  });

  it('GUARDIAN branch sub-query JOINs sis_students with s.school_id = $tenant.schoolId', async () => {
    const capturedSql: string[] = [];
    const fake = makeFake((call) => {
      capturedSql.push(call.sql);
      if (call.sql.includes('FROM fds_preorder_windows WHERE id')) {
        return [
          {
            id: 'w1',
            school_id: SCHOOL.schoolId,
            service_date: new Date('2026-05-20'),
            meal_type: 'LUNCH',
            opens_at: new Date(Date.now() - 60 * 60 * 1000),
            closes_at: new Date(Date.now() + 60 * 60 * 1000),
          },
        ];
      }
      return [];
    });
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPreorder(
          {
            studentId: 'cross-school-child',
            preorderWindowId: 'w1',
            items: [{ menuItemId: 'mi1', quantity: 1 }],
          },
          GUARDIAN_ACTOR,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
    const guardianSql = capturedSql.find(
      (s) =>
        s.includes('SELECT 1 AS ok FROM sis_student_guardians sg') &&
        s.includes('JOIN sis_guardians g'),
    );
    expect(guardianSql).toBeDefined();
    expect(guardianSql).toContain('JOIN sis_students s ON s.id = sg.student_id');
    expect(guardianSql).toContain('s.school_id = $1::uuid');
    expect(guardianSql).toContain('sg.student_id = $2::uuid');
    expect(guardianSql).toContain('g.person_id = $3::uuid');
  });
});

describe('REVIEW-P2C10 ROUND 2 — BLOCKING 2 FSM admin on-behalf validates studentId in current tenant', () => {
  it('FSM admin with cross-school studentId is refused with 400, not silently inserted', async () => {
    const capturedSql: string[] = [];
    const fake = makeFake((call) => {
      capturedSql.push(call.sql);
      if (call.sql.includes('FROM fds_preorder_windows WHERE id')) {
        return [
          {
            id: 'w1',
            school_id: SCHOOL.schoolId,
            service_date: new Date('2026-05-20'),
            meal_type: 'LUNCH',
            opens_at: new Date(Date.now() - 60 * 60 * 1000),
            closes_at: new Date(Date.now() + 60 * 60 * 1000),
          },
        ];
      }
      // The new admin-path validation query returns no row → cross-school
      // studentId is rejected.
      if (
        call.sql.includes('SELECT 1 AS ok FROM sis_students WHERE school_id') &&
        call.sql.includes('AND id =')
      ) {
        return [];
      }
      return [];
    });
    const svc = new PreorderService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPreorder(
          {
            studentId: '019e0cf8-bbbb-7000-bbbb-deadbeef0000',
            preorderWindowId: 'w1',
            items: [{ menuItemId: 'mi1', quantity: 1 }],
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
    // Defence-in-depth — INSERT did NOT fire.
    const inserts = capturedSql.filter((s) => s.startsWith('INSERT INTO fds_meal_preorders'));
    expect(inserts).toEqual([]);
  });
});

describe('REVIEW-P2C10 ROUND 2 — BLOCKING 3 STAFF without FDS-006 refused on every admin op', () => {
  it('STAFF without fds-006:write cannot create preorder windows', async () => {
    const fake = makeFake(() => []);
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createWindow(
          {
            serviceDate: '2026-06-01',
            mealType: 'LUNCH',
            opensAt: '2026-06-01T07:00:00Z',
            closesAt: '2026-06-01T09:00:00Z',
          },
          STAFF_ACTOR,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('STAFF without fds-006:write cannot confirm preorders', async () => {
    const fake = makeFake(() => []);
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.confirmPreorder('p1', STAFF_ACTOR)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('STAFF without fds-006:write cannot generate production reports', async () => {
    const fake = makeFake(() => []);
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.generateProductionReport({ serviceDate: '2026-06-01', mealType: 'LUNCH' }, STAFF_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('STAFF without fds-006:write cannot submit on-behalf orders bypassing the window gate', async () => {
    // STAFF with allow=false has neither isSchoolAdmin nor FDS-006:write.
    // The window gate bypass NO LONGER fires for them. A closed window
    // is rejected with 400.
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fds_preorder_windows WHERE id')) {
        return [
          {
            id: 'w-closed',
            school_id: SCHOOL.schoolId,
            service_date: new Date('2026-05-20'),
            meal_type: 'LUNCH',
            // window not yet open
            opens_at: new Date(Date.now() + 60 * 60 * 1000),
            closes_at: new Date(Date.now() + 4 * 60 * 60 * 1000),
          },
        ];
      }
      return [];
    });
    const svc = new PreorderService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPreorder(
          {
            studentId: 's1',
            preorderWindowId: 'w-closed',
            items: [{ menuItemId: 'mi1', quantity: 1 }],
          },
          STAFF_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
