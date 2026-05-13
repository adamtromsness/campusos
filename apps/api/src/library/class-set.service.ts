import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  ClassSetCheckoutResponseDto,
  ClassSetStatus,
  CreateClassSetCheckoutDto,
  ListClassSetsArgsDto,
  ReturnClassSetCopiesDto,
} from './dto/library-advanced.dto';

/**
 * P2-25a Step 4 — ClassSetService.
 *
 * Bulk-checkout coordination service. The keystone path is `create`:
 *
 *   1. Validate copy_count <= available copies of the catalogue item.
 *   2. Validate the teacher exists as an hr_employees row in this
 *      tenant (the schema only has a soft FK on platform.iam_person).
 *   3. Open one tenant tx, lock `copy_count` available copies of the
 *      item with SELECT … FOR UPDATE so concurrent class set creates
 *      cannot race each other into double-allocating the same copies.
 *   4. INSERT the lib_class_set_checkouts row.
 *   5. INSERT one lib_checkouts row per locked copy with status=ACTIVE
 *      and class_set_checkout_id pointing at the parent.
 *   6. UPDATE each locked copy to is_available=false / location_status=
 *      CHECKED_OUT.
 *
 * On the return path:
 *   - Increment returned_count on the class set row.
 *   - Walk the state machine: returned_count = 0 → ACTIVE,
 *     0 < returned_count < copy_count → PARTIALLY_RETURNED,
 *     returned_count = copy_count → RETURNED.
 *   - Mark `copiesReturned` individual lib_checkouts rows as RETURNED
 *     and flip the matching lib_catalogue_copies back to is_available=
 *     true / ON_SHELF.
 *   - Specific barcodes may be supplied; otherwise the service picks
 *     the oldest still-ACTIVE rows linked to this class set.
 */

interface ClassSetRow {
  id: string;
  school_id: string;
  catalogue_item_id: string;
  catalogue_item_title: string | null;
  catalogue_item_author: string | null;
  teacher_patron_id: string;
  teacher_first: string | null;
  teacher_last: string | null;
  class_id: string | null;
  copy_count: number;
  checkout_date: string;
  due_date: string;
  returned_count: number;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_CLASS_SET_BASE =
  'SELECT cs.id::text AS id, cs.school_id::text AS school_id, ' +
  'cs.catalogue_item_id::text AS catalogue_item_id, ' +
  'ci.title AS catalogue_item_title, ci.author AS catalogue_item_author, ' +
  'cs.teacher_patron_id::text AS teacher_patron_id, ' +
  'tp.first_name AS teacher_first, tp.last_name AS teacher_last, ' +
  'cs.class_id::text AS class_id, ' +
  'cs.copy_count, ' +
  "TO_CHAR(cs.checkout_date, 'YYYY-MM-DD') AS checkout_date, " +
  "TO_CHAR(cs.due_date, 'YYYY-MM-DD') AS due_date, " +
  'cs.returned_count, cs.status, cs.notes, ' +
  'TO_CHAR(cs.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(cs.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_class_set_checkouts cs ' +
  'LEFT JOIN lib_catalogue_items ci ON ci.id = cs.catalogue_item_id ' +
  'LEFT JOIN platform.iam_person tp ON tp.id = cs.teacher_patron_id ';

function rowToClassSetDto(r: ClassSetRow): ClassSetCheckoutResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    catalogueItemId: r.catalogue_item_id,
    catalogueItemTitle: r.catalogue_item_title,
    catalogueItemAuthor: r.catalogue_item_author,
    teacherPatronId: r.teacher_patron_id,
    teacherName: r.teacher_first && r.teacher_last ? r.teacher_first + ' ' + r.teacher_last : null,
    classId: r.class_id,
    copyCount: r.copy_count,
    checkoutDate: r.checkout_date,
    dueDate: r.due_date,
    returnedCount: r.returned_count,
    status: r.status as ClassSetStatus,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class ClassSetService {
  private readonly logger = new Logger(ClassSetService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Librarian scope: admin OR holds lib-002:write. The IAM seed
   * grants lib-002:write only to Staff (covering the librarian) so
   * the service uses this single test as "is this caller running
   * the circulation desk?". The plan-text talks about
   * teacher-requested class sets — that flow goes through a future
   * Request modal that today is just emailing the librarian; the
   * actual lib_class_set_checkouts row is always created by the
   * librarian or admin.
   */
  private async hasLibrarianScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-002:write',
    ]);
  }

  async list(args: ListClassSetsArgsDto): Promise<ClassSetCheckoutResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_CLASS_SET_BASE, 'WHERE cs.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    let idx = 2;
    if (args.status) {
      sql.push('AND cs.status = $' + idx + ' ');
      params.push(args.status);
      idx++;
    }
    if (args.teacherPatronId) {
      sql.push('AND cs.teacher_patron_id = $' + idx + '::uuid ');
      params.push(args.teacherPatronId);
      idx++;
    }
    sql.push('ORDER BY cs.checkout_date DESC, cs.id ASC LIMIT 200');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ClassSetRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToClassSetDto);
  }

  async getById(id: string): Promise<ClassSetCheckoutResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ClassSetRow[]>(
        SELECT_CLASS_SET_BASE + 'WHERE cs.id = $1::uuid AND cs.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Class set ' + id);
    return rowToClassSetDto(rows[0]!);
  }

  /**
   * KEYSTONE — create a class set checkout.
   *
   * The contract is: copy_count individual lib_checkouts must land
   * atomically with the parent class set row. Either every row commits
   * or none of them do. The schema CHECK on copy_count > 0 + the
   * dates_chk + the FK on catalogue_item_id are the safety net; the
   * service is the gate.
   */
  async create(
    input: CreateClassSetCheckoutDto,
    actor: ResolvedActor,
  ): Promise<ClassSetCheckoutResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can process class set checkouts');
    }
    if (input.copyCount < 1) {
      throw new BadRequestException('copyCount must be >= 1');
    }
    if (input.dueDate < input.checkoutDate) {
      throw new BadRequestException('dueDate must be on or after checkoutDate');
    }

    const tenant = getCurrentTenant();
    const id = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // 1. Validate the catalogue item exists in this tenant
      const itemRows = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM lib_catalogue_items WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.catalogueItemId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (itemRows.length === 0) {
        throw new NotFoundException('Catalogue item ' + input.catalogueItemId);
      }

      // 2. Validate the teacher has an hr_employees row in *this*
      //    tenant. teacher_patron_id is a soft ref to platform.iam_person,
      //    but schools only check class sets out to their own employees.
      //    The school_id predicate is the REVIEW-P2C25 BLOCKING 2 fix —
      //    a School A librarian cannot create a class set against a
      //    School B employee's iam_person UUID.
      const teacherRows = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM hr_employees WHERE person_id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.teacherPatronId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (teacherRows.length === 0) {
        throw new BadRequestException(
          'teacherPatronId does not match an hr_employees row in this school',
        );
      }

      // 2b. When classId is supplied, verify it belongs to this school.
      //     Soft ref to sis_classes per ADR-001/020 — the schema does not
      //     enforce; the service is the gate. REVIEW-P2C25 BLOCKING 2.
      if (input.classId) {
        const classRows = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_classes WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          input.classId,
          tenant.schoolId,
        )) as Array<{ ok: number }>;
        if (classRows.length === 0) {
          throw new BadRequestException('classId does not match a class in this school');
        }
      }

      // 3. Lock `copy_count` available copies of the item with FOR
      //    UPDATE so concurrent class-set creates cannot double-allocate.
      //    The LIMIT clause is the cap; the FOR UPDATE pins the rows.
      const lockedCopies = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, barcode FROM lib_catalogue_copies ' +
          'WHERE catalogue_item_id = $1::uuid AND is_available = true ' +
          "AND location_status = 'ON_SHELF' " +
          'ORDER BY barcode ASC ' +
          'LIMIT $2 FOR UPDATE',
        input.catalogueItemId,
        input.copyCount,
      )) as Array<{ id: string; barcode: string }>;

      if (lockedCopies.length < input.copyCount) {
        throw new BadRequestException(
          'Cannot check out ' +
            input.copyCount +
            ' copies — only ' +
            lockedCopies.length +
            ' copies of this catalogue item are currently available on shelf.',
        );
      }

      // 4. INSERT the lib_class_set_checkouts row
      await tx.$executeRawUnsafe(
        'INSERT INTO lib_class_set_checkouts ' +
          '(id, school_id, catalogue_item_id, teacher_patron_id, class_id, copy_count, checkout_date, due_date, returned_count, status, notes) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::date, $8::date, 0, 'ACTIVE', $9)",
        id,
        tenant.schoolId,
        input.catalogueItemId,
        input.teacherPatronId,
        input.classId ?? null,
        input.copyCount,
        input.checkoutDate,
        input.dueDate,
        input.notes ?? null,
      );

      // 5. INSERT one lib_checkouts row per locked copy and flip copy state
      for (const c of lockedCopies) {
        const checkoutId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO lib_checkouts ' +
            '(id, copy_id, patron_id, checkout_date, due_date, status, class_set_checkout_id) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, 'ACTIVE', $6::uuid)",
          checkoutId,
          c.id,
          input.teacherPatronId,
          input.checkoutDate,
          input.dueDate,
          id,
        );
        await tx.$executeRawUnsafe(
          "UPDATE lib_catalogue_copies SET is_available = false, location_status = 'CHECKED_OUT', updated_at = now() WHERE id = $1::uuid",
          c.id,
        );
      }

      this.logger.log(
        '[class-set.create] id=' +
          id.slice(0, 8) +
          ' item=' +
          input.catalogueItemId.slice(0, 8) +
          ' copies=' +
          input.copyCount +
          ' teacher=' +
          input.teacherPatronId.slice(0, 8),
      );
    });

    return this.getById(id);
  }

  /**
   * Return N copies. Walks the state machine:
   *   returned_count = 0 → ACTIVE
   *   0 < returned_count < copy_count → PARTIALLY_RETURNED
   *   returned_count = copy_count → RETURNED
   *
   * Locks the parent class set row and the matching lib_checkouts
   * rows + parent lib_catalogue_copies all in one tx so a partial
   * failure rolls back cleanly.
   */
  async returnCopies(
    id: string,
    input: ReturnClassSetCopiesDto,
    actor: ResolvedActor,
  ): Promise<ClassSetCheckoutResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can return class set copies');
    }
    if (input.copiesReturned < 1) {
      throw new BadRequestException('copiesReturned must be >= 1');
    }

    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the parent class set — school-scoped per REVIEW-P2C25
      // BLOCKING 1 so a School A librarian cannot return copies on a
      // School B class set by UUID guess.
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, copy_count, returned_count, status, school_id::text AS school_id ' +
          'FROM lib_class_set_checkouts WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{
        id: string;
        copy_count: number;
        returned_count: number;
        status: string;
        school_id: string;
      }>;
      if (lockRows.length === 0) throw new NotFoundException('Class set ' + id);
      const cs = lockRows[0]!;
      if (cs.status === 'RETURNED') {
        throw new BadRequestException('Class set is already fully RETURNED');
      }
      const newReturnedCount = cs.returned_count + input.copiesReturned;
      if (newReturnedCount > cs.copy_count) {
        throw new BadRequestException(
          'Cannot return ' +
            input.copiesReturned +
            ' copies — only ' +
            (cs.copy_count - cs.returned_count) +
            ' copies are still out.',
        );
      }

      // Pick the actual lib_checkouts rows to flip. If specific
      // barcodes were supplied, restrict to those; otherwise pick the
      // oldest ACTIVE rows under this class set.
      let lockedCheckouts: Array<{ id: string; copy_id: string }>;
      if (input.barcodes && input.barcodes.length > 0) {
        if (input.barcodes.length !== input.copiesReturned) {
          throw new BadRequestException(
            'When barcodes are supplied, exactly copiesReturned barcodes must be listed (got ' +
              input.barcodes.length +
              ', expected ' +
              input.copiesReturned +
              ')',
          );
        }
        lockedCheckouts = (await tx.$queryRawUnsafe(
          'SELECT co.id::text AS id, co.copy_id::text AS copy_id ' +
            'FROM lib_checkouts co ' +
            'JOIN lib_catalogue_copies cp ON cp.id = co.copy_id ' +
            "WHERE co.class_set_checkout_id = $1::uuid AND co.status = 'ACTIVE' " +
            'AND cp.barcode = ANY($2::text[]) ' +
            'ORDER BY co.checkout_date ASC ' +
            'FOR UPDATE OF co',
          id,
          input.barcodes,
        )) as Array<{ id: string; copy_id: string }>;
        if (lockedCheckouts.length !== input.copiesReturned) {
          throw new BadRequestException(
            'One or more supplied barcodes are not active under this class set',
          );
        }
      } else {
        lockedCheckouts = (await tx.$queryRawUnsafe(
          'SELECT co.id::text AS id, co.copy_id::text AS copy_id ' +
            "FROM lib_checkouts co WHERE co.class_set_checkout_id = $1::uuid AND co.status = 'ACTIVE' " +
            'ORDER BY co.checkout_date ASC, co.id ASC ' +
            'LIMIT $2 FOR UPDATE',
          id,
          input.copiesReturned,
        )) as Array<{ id: string; copy_id: string }>;
        if (lockedCheckouts.length < input.copiesReturned) {
          throw new BadRequestException(
            'Cannot return ' +
              input.copiesReturned +
              ' copies — only ' +
              lockedCheckouts.length +
              ' individual checkouts under this class set are still ACTIVE.',
          );
        }
      }

      // Flip each checkout to RETURNED and each copy back to ON_SHELF
      for (const c of lockedCheckouts) {
        await tx.$executeRawUnsafe(
          "UPDATE lib_checkouts SET status = 'RETURNED', returned_at = now(), updated_at = now() WHERE id = $1::uuid",
          c.id,
        );
        await tx.$executeRawUnsafe(
          "UPDATE lib_catalogue_copies SET is_available = true, location_status = 'ON_SHELF', updated_at = now() WHERE id = $1::uuid",
          c.copy_id,
        );
      }

      // Walk the state machine
      let newStatus: ClassSetStatus = 'PARTIALLY_RETURNED';
      if (newReturnedCount === cs.copy_count) {
        newStatus = 'RETURNED';
      } else if (newReturnedCount === 0) {
        newStatus = 'ACTIVE';
      }
      // The parent was locked above with `id + school_id` so the school
      // predicate is already proven; carry it on the UPDATE as
      // defence-in-depth (REVIEW-P2C25 BLOCKING 1).
      await tx.$executeRawUnsafe(
        'UPDATE lib_class_set_checkouts SET returned_count = $1, status = $2, updated_at = now() ' +
          'WHERE id = $3::uuid AND school_id = $4::uuid',
        newReturnedCount,
        newStatus,
        id,
        tenant.schoolId,
      );

      this.logger.log(
        '[class-set.return] id=' +
          id.slice(0, 8) +
          ' returned=' +
          input.copiesReturned +
          ' total=' +
          newReturnedCount +
          '/' +
          cs.copy_count +
          ' status=' +
          newStatus,
      );
    });

    return this.getById(id);
  }

  /**
   * Sweep nightly. For every ACTIVE or PARTIALLY_RETURNED row where
   * due_date < CURRENT_DATE and returned_count < copy_count, flip to
   * OVERDUE. Idempotent — re-running on the same tenant is a no-op
   * because OVERDUE rows fall out of the WHERE filter.
   *
   * Returns the list of flipped class set ids for logging.
   */
  async sweepOverdueForCurrentTenant(): Promise<string[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C25 BLOCKING 1 — bind the sweep to the current tenant's
      // school_id so a worker pass running under School A context cannot
      // flip School B class sets in a shared-schema future. The
      // search_path SET LOCAL already pins the schema; this is the row
      // -level cross-school guard.
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        "UPDATE lib_class_set_checkouts SET status = 'OVERDUE', updated_at = now() " +
          'WHERE school_id = $1::uuid ' +
          "AND status IN ('ACTIVE', 'PARTIALLY_RETURNED') " +
          'AND due_date < CURRENT_DATE ' +
          'AND returned_count < copy_count ' +
          'RETURNING id::text AS id',
        tenant.schoolId,
      );
    });
    return rows.map((r) => r.id);
  }
}
