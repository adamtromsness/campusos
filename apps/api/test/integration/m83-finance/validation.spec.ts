import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FinanceValidationService } from '@modules/m83-finance/validation';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  TEST_FUND_ID,
  TEST_FUND_B_ID,
  TEST_COA_CASH_ID,
  TEST_COA_AR_ID,
  TEST_COA_REVENUE_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_COA_SUPPLIES_B_ID,
  TEST_PERIOD_ID,
  TEST_PERIOD_B_ID,
  TEST_BUDGET_ID,
  TEST_BUDGET_LINE_ID,
  TEST_SUPPLIER_A_ID,
  TEST_SUPPLIER_B_SCHOOL_ID,
  TEST_INACTIVE_SUPPLIER_ID,
} from '../fixtures/finance';

/**
 * DB-backed integration tests for FinanceValidationService — the
 * service-layer validation helpers used by every finance write path.
 *
 * Coverage:
 *   - assertActiveFund: missing id, cross-school, inactive, valid
 *   - assertActiveAccount: missing id, cross-school, inactive, type filter
 *   - assertPeriodInState: missing id, status filter, valid
 *   - assertBudgetLineInCurrentTenant: missing budget line, DRAFT budget
 *     rejected, APPROVED accepted, cross-school
 *   - assertActiveSupplier: missing, inactive, cross-school, valid
 */
describe('integration:m83-finance/validation', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: FinanceValidationService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    service = new FinanceValidationService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  describe('assertActiveFund', () => {
    it('valid fund in current school passes', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveFund(TEST_FUND_ID)).resolves.toBeUndefined();
      });
    });

    it('empty id → BadRequest with field name', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveFund('', 'myField')).rejects.toThrow(
          /myField is required/,
        );
      });
    });

    it('cross-school fund → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveFund(TEST_FUND_B_ID)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });

    it('inactive fund → BadRequest', async () => {
      const inactiveFundId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fin_funds (id, school_id, fund_code, fund_name, fund_type, is_active)
         VALUES ($1::uuid, $2::uuid, $3, 'Inactive', 'GENERAL', false)`,
        inactiveFundId,
        TEST_SCHOOL_ID,
        'INACT-FND-' + inactiveFundId.slice(0, 8),
      );
      try {
        await withTestTenant(async () => {
          await expect(service.assertActiveFund(inactiveFundId)).rejects.toBeInstanceOf(
            BadRequestException,
          );
        });
      } finally {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.fin_funds WHERE id = $1::uuid`,
          inactiveFundId,
        );
      }
    });

    it('non-existent id → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveFund(generateId())).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });
  });

  describe('assertActiveAccount', () => {
    it('valid account passes with no type filter', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveAccount(TEST_COA_CASH_ID)).resolves.toBeUndefined();
      });
    });

    it('empty id → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveAccount('', undefined, 'foo')).rejects.toThrow(
          /foo is required/,
        );
      });
    });

    it('inactive account → BadRequest mentioning code/name', async () => {
      // Deactivate temporarily
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.fin_chart_of_accounts SET is_active = false WHERE id = $1::uuid`,
        TEST_COA_AR_ID,
      );
      try {
        await withTestTenant(async () => {
          await expect(service.assertActiveAccount(TEST_COA_AR_ID)).rejects.toThrow(/inactive/);
        });
      } finally {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.fin_chart_of_accounts SET is_active = true WHERE id = $1::uuid`,
          TEST_COA_AR_ID,
        );
      }
    });

    it('type filter: ASSET account passes when allowedTypes=[ASSET]', async () => {
      await withTestTenant(async () => {
        await expect(
          service.assertActiveAccount(TEST_COA_CASH_ID, ['ASSET']),
        ).resolves.toBeUndefined();
      });
    });

    it('type filter: REVENUE account when allowedTypes=[ASSET] → BadRequest mentioning expected types', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveAccount(TEST_COA_REVENUE_ID, ['ASSET'])).rejects.toThrow(
          /expected one of ASSET/,
        );
      });
    });

    it('type filter accepts when account_type matches one of allowed', async () => {
      await withTestTenant(async () => {
        await expect(
          service.assertActiveAccount(TEST_COA_REVENUE_ID, ['REVENUE', 'EXPENSE']),
        ).resolves.toBeUndefined();
      });
    });

    it('empty allowedTypes array is treated as no filter', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveAccount(TEST_COA_CASH_ID, [])).resolves.toBeUndefined();
      });
    });

    it('cross-school account → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveAccount(TEST_COA_SUPPLIES_B_ID)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });

    it('non-existent account → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveAccount(generateId())).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });
  });

  describe('assertPeriodInState', () => {
    it('valid OPEN period passes when allowedStatuses=[OPEN]', async () => {
      await withTestTenant(async () => {
        await expect(
          service.assertPeriodInState(TEST_PERIOD_ID, ['OPEN']),
        ).resolves.toBeUndefined();
      });
    });

    it('no allowedStatuses → only existence check', async () => {
      await withTestTenant(async () => {
        await expect(service.assertPeriodInState(TEST_PERIOD_ID)).resolves.toBeUndefined();
      });
    });

    it('empty id → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertPeriodInState('', undefined, 'pid')).rejects.toThrow(
          /pid is required/,
        );
      });
    });

    it('cross-school period → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertPeriodInState(TEST_PERIOD_B_ID)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });

    it('CLOSED period rejected when allowedStatuses=[OPEN]', async () => {
      // Temporarily flip period to CLOSED
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.fin_accounting_periods SET status = 'CLOSED', closed_at = now(), closed_by = $2::uuid WHERE id = $1::uuid`,
        TEST_PERIOD_ID,
        '019e0cf8-aaaa-7777-8888-000000000011', // admin account id
      );
      try {
        await withTestTenant(async () => {
          await expect(service.assertPeriodInState(TEST_PERIOD_ID, ['OPEN'])).rejects.toThrow(
            /status=CLOSED/,
          );
        });
      } finally {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.fin_accounting_periods SET status = 'OPEN', closed_at = NULL, closed_by = NULL WHERE id = $1::uuid`,
          TEST_PERIOD_ID,
        );
      }
    });

    it('non-existent period → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertPeriodInState(generateId())).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });
  });

  describe('assertBudgetLineInCurrentTenant', () => {
    it('APPROVED budget line passes (fixture defaults to APPROVED)', async () => {
      await withTestTenant(async () => {
        await expect(
          service.assertBudgetLineInCurrentTenant(TEST_BUDGET_LINE_ID),
        ).resolves.toBeUndefined();
      });
    });

    it('DRAFT budget line → BadRequest mentioning status', async () => {
      // Temporarily flip the fixture budget to DRAFT
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.fin_budgets SET status = 'DRAFT' WHERE id = $1::uuid`,
        TEST_BUDGET_ID,
      );
      try {
        await withTestTenant(async () => {
          await expect(
            service.assertBudgetLineInCurrentTenant(TEST_BUDGET_LINE_ID),
          ).rejects.toThrow(/status=DRAFT/);
        });
      } finally {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.fin_budgets SET status = 'APPROVED' WHERE id = $1::uuid`,
          TEST_BUDGET_ID,
        );
      }
    });

    it('empty id → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertBudgetLineInCurrentTenant('', 'blid')).rejects.toThrow(
          /blid is required/,
        );
      });
    });

    it('non-existent budget line → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertBudgetLineInCurrentTenant(generateId())).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });
  });

  describe('assertActiveSupplier', () => {
    it('valid active supplier passes', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveSupplier(TEST_SUPPLIER_A_ID)).resolves.toBeUndefined();
      });
    });

    it('empty id → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveSupplier('', 'sid')).rejects.toThrow(/sid is required/);
      });
    });

    it('inactive supplier → BadRequest with supplier code/name', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveSupplier(TEST_INACTIVE_SUPPLIER_ID)).rejects.toThrow(
          /inactive/,
        );
      });
    });

    it('cross-school supplier → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(
          service.assertActiveSupplier(TEST_SUPPLIER_B_SCHOOL_ID),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('non-existent supplier → BadRequest', async () => {
      await withTestTenant(async () => {
        await expect(service.assertActiveSupplier(generateId())).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });
  });
});
