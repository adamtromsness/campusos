import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import {
  CheckoutCreateDto,
  CheckoutPolicyResponseDto,
  CheckoutResponseDto,
  CheckoutStatus,
  ListCheckoutsArgsDto,
  PatronType,
} from './dto/library.dto';

interface CheckoutRow {
  id: string;
  copy_id: string;
  copy_barcode: string;
  item_title: string | null;
  patron_id: string;
  patron_first: string | null;
  patron_last: string | null;
  checkout_date: string;
  due_date: string;
  returned_at: string | null;
  renewal_count: number;
  status: string;
  days_until_due: number | null;
  created_at: string;
  updated_at: string;
}

interface PolicyRow {
  id: string;
  school_id: string;
  patron_type: string;
  max_checkouts: number;
  loan_period_days: number;
  renewals_allowed: number;
  overdue_fine_per_day: string;
}

const SELECT_CHECKOUT_BASE =
  'SELECT co.id::text AS id, co.copy_id::text AS copy_id, ' +
  'cp.barcode AS copy_barcode, ci.title AS item_title, ' +
  'co.patron_id::text AS patron_id, ' +
  'p.first_name AS patron_first, p.last_name AS patron_last, ' +
  "TO_CHAR(co.checkout_date, 'YYYY-MM-DD') AS checkout_date, " +
  "TO_CHAR(co.due_date, 'YYYY-MM-DD') AS due_date, " +
  'TO_CHAR(co.returned_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS returned_at, ' +
  'co.renewal_count, co.status, ' +
  'CASE WHEN co.returned_at IS NULL THEN (co.due_date - CURRENT_DATE)::int ELSE NULL END AS days_until_due, ' +
  'TO_CHAR(co.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(co.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_checkouts co ' +
  'LEFT JOIN lib_catalogue_copies cp ON cp.id = co.copy_id ' +
  'LEFT JOIN lib_catalogue_items ci ON ci.id = cp.catalogue_item_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = co.patron_id ';

function rowToCheckoutDto(r: CheckoutRow): CheckoutResponseDto {
  return {
    id: r.id,
    copyId: r.copy_id,
    copyBarcode: r.copy_barcode,
    itemTitle: r.item_title,
    patronId: r.patron_id,
    patronName: r.patron_first && r.patron_last ? r.patron_first + ' ' + r.patron_last : null,
    checkoutDate: r.checkout_date,
    dueDate: r.due_date,
    returnedAt: r.returned_at,
    renewalCount: r.renewal_count,
    status: r.status as CheckoutStatus,
    daysUntilDue: r.days_until_due,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Librarian scope: admin OR holds lib-002:write — the canonical
   * circulation signal. The IAM seed grants lib-002:write only to
   * Staff (covering the librarian) so the service uses it as a
   * single test for "is this caller running the desk?".
   */
  private async hasLibrarianScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-002:write',
    ]);
  }

  /**
   * Patron type resolution. A patron is either a STUDENT (has a row
   * in platform.platform_students with matching person_id) or STAFF
   * (has an hr_employees row with matching person_id). Used to look
   * up the matching lib_checkout_policies row at checkout time.
   */
  private async resolvePatronType(personId: string): Promise<PatronType | null> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT ' +
          '(EXISTS (SELECT 1 FROM platform.platform_students WHERE person_id = $1::uuid)) AS is_student, ' +
          '(EXISTS (SELECT 1 FROM hr_employees WHERE person_id = $1::uuid)) AS is_staff',
        personId,
      )) as Array<{ is_student: boolean; is_staff: boolean }>;
      if (rows.length === 0) return null;
      if (rows[0]!.is_student) return 'STUDENT';
      if (rows[0]!.is_staff) return 'STAFF';
      return null;
    });
  }

  /**
   * Look up the policy for the calling school + patron type.
   */
  async loadPolicy(patronType: PatronType): Promise<CheckoutPolicyResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PolicyRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, patron_type, ' +
          'max_checkouts, loan_period_days, renewals_allowed, ' +
          'overdue_fine_per_day::text AS overdue_fine_per_day ' +
          'FROM lib_checkout_policies WHERE school_id = $1::uuid AND patron_type = $2',
        tenant.schoolId,
        patronType,
      );
    });
    if (rows.length === 0) {
      throw new BadRequestException(
        'No lib_checkout_policies row configured for patron_type=' +
          patronType +
          '. The librarian or admin must create the policy before processing checkouts for this patron class.',
      );
    }
    const r = rows[0]!;
    return {
      id: r.id,
      schoolId: r.school_id,
      patronType: r.patron_type as PatronType,
      maxCheckouts: r.max_checkouts,
      loanPeriodDays: r.loan_period_days,
      renewalsAllowed: r.renewals_allowed,
      overdueFinePerDay: Number(r.overdue_fine_per_day),
    };
  }

  async listPolicies(): Promise<CheckoutPolicyResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PolicyRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, patron_type, ' +
          'max_checkouts, loan_period_days, renewals_allowed, ' +
          'overdue_fine_per_day::text AS overdue_fine_per_day ' +
          'FROM lib_checkout_policies WHERE school_id = $1::uuid ORDER BY patron_type ASC',
        tenant.schoolId,
      );
    });
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      patronType: r.patron_type as PatronType,
      maxCheckouts: r.max_checkouts,
      loanPeriodDays: r.loan_period_days,
      renewalsAllowed: r.renewals_allowed,
      overdueFinePerDay: Number(r.overdue_fine_per_day),
    }));
  }

  /**
   * KEYSTONE — checkout by barcode. Resolves barcode → copy → parent
   * item, validates patron hasn't exceeded max_checkouts, validates
   * copy is_available, creates the checkout row + flips the copy
   * state, all inside one tenant transaction with FOR UPDATE on the
   * copy row to serialise concurrent scans.
   */
  async checkout(input: CheckoutCreateDto, actor: ResolvedActor): Promise<CheckoutResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can process library checkouts');
    }
    if (!input.barcode && !input.copyId) {
      throw new BadRequestException('Provide either barcode or copyId');
    }

    const patronType = await this.resolvePatronType(input.patronId);
    if (!patronType) {
      throw new BadRequestException(
        'Patron is neither a student nor a staff member in this school',
      );
    }
    const policy = await this.loadPolicy(patronType);
    const loanDays = input.loanPeriodDays ?? policy.loanPeriodDays;

    const checkoutId = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Resolve + lock the copy row
      let copyRow:
        | {
            id: string;
            barcode: string;
            is_available: boolean;
            location_status: string;
          }
        | undefined;
      if (input.barcode) {
        const rows = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id, barcode, is_available, location_status FROM lib_catalogue_copies WHERE barcode = $1 FOR UPDATE',
          input.barcode,
        )) as Array<{
          id: string;
          barcode: string;
          is_available: boolean;
          location_status: string;
        }>;
        if (rows.length === 0) {
          throw new NotFoundException(
            'Library copy with barcode "' + input.barcode + '" not found',
          );
        }
        copyRow = rows[0];
      } else {
        const rows = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id, barcode, is_available, location_status FROM lib_catalogue_copies WHERE id = $1::uuid FOR UPDATE',
          input.copyId!,
        )) as Array<{
          id: string;
          barcode: string;
          is_available: boolean;
          location_status: string;
        }>;
        if (rows.length === 0) throw new NotFoundException('Library copy ' + input.copyId);
        copyRow = rows[0];
      }
      const copy = copyRow!;

      if (!copy.is_available) {
        throw new BadRequestException(
          'Copy ' +
            copy.barcode +
            ' is not available for checkout (status=' +
            copy.location_status +
            ').',
        );
      }

      // Count active checkouts for this patron, enforce max_checkouts
      const activeCount = (await tx.$queryRawUnsafe(
        'SELECT count(*)::int AS c FROM lib_checkouts WHERE patron_id = $1::uuid AND returned_at IS NULL',
        input.patronId,
      )) as Array<{ c: number }>;
      const active = activeCount[0]?.c ?? 0;
      if (active >= policy.maxCheckouts) {
        throw new BadRequestException(
          'Patron has reached the maximum of ' +
            policy.maxCheckouts +
            ' active checkouts for ' +
            patronType +
            ' patrons. Return a book before checking out another.',
        );
      }

      // Insert checkout + flip copy state atomically
      await tx.$executeRawUnsafe(
        'INSERT INTO lib_checkouts (id, copy_id, patron_id, checkout_date, due_date, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE, CURRENT_DATE + ($4 || ' days')::interval, 'ACTIVE')",
        checkoutId,
        copy.id,
        input.patronId,
        loanDays,
      );
      await tx.$executeRawUnsafe(
        "UPDATE lib_catalogue_copies SET is_available = false, location_status = 'CHECKED_OUT', updated_at = now() WHERE id = $1::uuid",
        copy.id,
      );
    });

    return this.getById(checkoutId);
  }

  /**
   * Return path. Stamps returned_at + flips status to RETURNED. If
   * past due, computes days_overdue × policy.overdue_fine_per_day
   * and INSERTs a fine row. Then walks the hold queue: if a PENDING
   * hold exists for the parent catalogue item, flips the oldest hold
   * to READY + walks the copy to ON_HOLD_SHELF; otherwise the copy
   * returns to ON_SHELF and is_available=true. Emits lib.fine.issued
   * after the tx commits when a fine was created.
   */
  async returnCheckout(checkoutId: string, actor: ResolvedActor): Promise<CheckoutResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can return checkouts');
    }

    let createdFine: {
      id: string;
      checkoutId: string;
      patronId: string;
      fineType: 'OVERDUE';
      amount: number;
      daysOverdue: number;
    } | null = null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock checkout row
      const rows = (await tx.$queryRawUnsafe(
        'SELECT co.id::text AS id, co.copy_id::text AS copy_id, co.patron_id::text AS patron_id, ' +
          'co.due_date, co.status, ' +
          'cp.catalogue_item_id::text AS catalogue_item_id ' +
          'FROM lib_checkouts co JOIN lib_catalogue_copies cp ON cp.id = co.copy_id ' +
          'WHERE co.id = $1::uuid FOR UPDATE',
        checkoutId,
      )) as Array<{
        id: string;
        copy_id: string;
        patron_id: string;
        due_date: string;
        status: string;
        catalogue_item_id: string;
      }>;
      if (rows.length === 0) throw new NotFoundException('Checkout ' + checkoutId);
      const co = rows[0]!;
      if (co.status === 'RETURNED') {
        throw new BadRequestException('Checkout already returned');
      }

      // Compute days_overdue
      const overdueRows = (await tx.$queryRawUnsafe(
        'SELECT GREATEST((CURRENT_DATE - $1::date)::int, 0) AS days_overdue',
        co.due_date,
      )) as Array<{ days_overdue: number }>;
      const daysOverdue = overdueRows[0]?.days_overdue ?? 0;

      // Stamp returned_at + status
      await tx.$executeRawUnsafe(
        "UPDATE lib_checkouts SET returned_at = now(), status = 'RETURNED', updated_at = now() WHERE id = $1::uuid",
        checkoutId,
      );

      // Auto-fine if overdue + policy has a non-zero rate
      if (daysOverdue > 0) {
        // Resolve patron policy
        const patronType = await this.resolvePatronType(co.patron_id);
        if (patronType) {
          const policy = await this.loadPolicy(patronType);
          if (policy.overdueFinePerDay > 0) {
            const fineId = generateId();
            const amount = Math.round(daysOverdue * policy.overdueFinePerDay * 100) / 100;
            await tx.$executeRawUnsafe(
              'INSERT INTO lib_fines (id, checkout_id, patron_id, fine_type, amount, days_overdue, status) ' +
                "VALUES ($1::uuid, $2::uuid, $3::uuid, 'OVERDUE', $4, $5, 'OUTSTANDING')",
              fineId,
              checkoutId,
              co.patron_id,
              amount,
              daysOverdue,
            );
            createdFine = {
              id: fineId,
              checkoutId,
              patronId: co.patron_id,
              fineType: 'OVERDUE',
              amount,
              daysOverdue,
            };
          }
        }
      }

      // Walk the hold queue
      const holdRows = (await tx.$queryRawUnsafe(
        "SELECT id::text AS id FROM lib_holds WHERE catalogue_item_id = $1::uuid AND status = 'PENDING' ORDER BY placed_at ASC LIMIT 1 FOR UPDATE",
        co.catalogue_item_id,
      )) as Array<{ id: string }>;

      if (holdRows.length > 0) {
        const holdId = holdRows[0]!.id;
        await tx.$executeRawUnsafe(
          "UPDATE lib_holds SET status = 'READY', notified_at = now(), updated_at = now() WHERE id = $1::uuid",
          holdId,
        );
        await tx.$executeRawUnsafe(
          "UPDATE lib_catalogue_copies SET is_available = false, location_status = 'ON_HOLD_SHELF', updated_at = now() WHERE id = $1::uuid",
          co.copy_id,
        );
      } else {
        await tx.$executeRawUnsafe(
          "UPDATE lib_catalogue_copies SET is_available = true, location_status = 'ON_SHELF', updated_at = now() WHERE id = $1::uuid",
          co.copy_id,
        );
      }
    });

    // Emit lib.fine.issued AFTER the tx commits so a Kafka hiccup
    // doesn't roll back the patron's return.
    if (createdFine) {
      const fine = createdFine as {
        id: string;
        checkoutId: string;
        patronId: string;
        fineType: 'OVERDUE';
        amount: number;
        daysOverdue: number;
      };
      const tenant = getCurrentTenant();
      try {
        await this.kafka.emit({
          topic: 'lib.fine.issued',
          key: fine.id,
          sourceModule: 'library',
          tenantId: tenant.schoolId,
          tenantSubdomain: tenant.subdomain,
          payload: {
            fineId: fine.id,
            checkoutId: fine.checkoutId,
            patronId: fine.patronId,
            fineType: fine.fineType,
            amount: fine.amount,
            daysOverdue: fine.daysOverdue,
            status: 'OUTSTANDING',
            sourceRefId: fine.id,
          },
        });
      } catch (err) {
        // Best-effort emit. Audit log will surface broker outages.
        console.error('[library] failed to emit lib.fine.issued for fine ' + fine.id, err);
      }
    }

    return this.getById(checkoutId);
  }

  async renew(checkoutId: string, actor: ResolvedActor): Promise<CheckoutResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can renew checkouts');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT co.id::text AS id, co.patron_id::text AS patron_id, co.due_date, co.status, co.renewal_count ' +
          'FROM lib_checkouts co WHERE co.id = $1::uuid FOR UPDATE',
        checkoutId,
      )) as Array<{
        id: string;
        patron_id: string;
        due_date: string;
        status: string;
        renewal_count: number;
      }>;
      if (rows.length === 0) throw new NotFoundException('Checkout ' + checkoutId);
      const co = rows[0]!;
      if (co.status !== 'ACTIVE' && co.status !== 'OVERDUE') {
        throw new BadRequestException(
          'Cannot renew a checkout in status ' + co.status + ' — only ACTIVE or OVERDUE.',
        );
      }
      const patronType = await this.resolvePatronType(co.patron_id);
      if (!patronType) {
        throw new BadRequestException('Patron type unresolved for ' + co.patron_id);
      }
      const policy = await this.loadPolicy(patronType);
      if (co.renewal_count >= policy.renewalsAllowed) {
        throw new BadRequestException(
          'Renewal limit reached (' +
            policy.renewalsAllowed +
            ' for ' +
            patronType +
            ' patrons). The patron must return the book.',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE lib_checkouts SET due_date = due_date + ($1 || ' days')::interval, " +
          "renewal_count = renewal_count + 1, status = 'ACTIVE', updated_at = now() " +
          'WHERE id = $2::uuid',
        policy.loanPeriodDays,
        checkoutId,
      );
    });
    return this.getById(checkoutId);
  }

  async list(args: ListCheckoutsArgsDto, actor: ResolvedActor): Promise<CheckoutResponseDto[]> {
    const isLibrarian = await this.hasLibrarianScope(actor);
    const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (!isLibrarian) {
      // Patron row scope: own checkouts only
      where.push('co.patron_id = $' + idx + '::uuid');
      params.push(actor.personId);
      idx++;
    } else if (args.patronId) {
      where.push('co.patron_id = $' + idx + '::uuid');
      params.push(args.patronId);
      idx++;
    }
    if (args.status) {
      where.push('co.status = $' + idx);
      params.push(args.status);
      idx++;
    }
    if (args.onlyActive) {
      where.push('co.returned_at IS NULL');
    }

    const sql =
      SELECT_CHECKOUT_BASE +
      (where.length > 0 ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
      'ORDER BY co.checkout_date DESC, co.id ASC LIMIT 200';
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CheckoutRow[]>(sql, ...params);
    });
    return rows.map(rowToCheckoutDto);
  }

  async listOverdue(actor: ResolvedActor): Promise<CheckoutResponseDto[]> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can read the overdue dashboard');
    }
    const sql =
      SELECT_CHECKOUT_BASE +
      'WHERE co.returned_at IS NULL AND co.due_date < CURRENT_DATE ' +
      'ORDER BY co.due_date ASC LIMIT 500';
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CheckoutRow[]>(sql);
    });
    return rows.map(rowToCheckoutDto);
  }

  async getById(id: string): Promise<CheckoutResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CheckoutRow[]>(
        SELECT_CHECKOUT_BASE + 'WHERE co.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Checkout ' + id);
    return rowToCheckoutDto(rows[0]!);
  }
}
