import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { assertStoreCustomer, isUniqueViolation } from './access';
import type { AddWishlistDto, UpdateWishlistDto, WishlistEntryDto } from './dto/commerce-store.dto';

interface WishlistRow {
  id: string;
  customer_person_id: string;
  product_id: string;
  notify_on_restock: boolean;
  created_at: string;
}

/**
 * P2-29b — WishlistService.
 *
 * Per-(customer, product) wishlist. UNIQUE(customer_person_id,
 * product_id) means re-adding is a no-op (translated to a friendly
 * 200 OK on the existing row). Customers may only manage their own
 * wishlist; admins may read any customer's wishlist for support
 * purposes. The partial INDEX on (product_id) WHERE
 * notify_on_restock = true backs the future RestockNotificationWorker
 * fan-out when stock crosses 0.
 */
@Injectable()
export class WishlistService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toDto(row: WishlistRow): WishlistEntryDto {
    return {
      id: row.id,
      customerPersonId: row.customer_person_id,
      productId: row.product_id,
      notifyOnRestock: row.notify_on_restock,
      createdAt: row.created_at,
    };
  }

  private async assertCanActFor(actor: ResolvedActor, customerPersonId: string): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personId === customerPersonId) return;
    const tenant = getCurrentTenant();
    const isAdmin = await this.permCheck.hasAnyPermissionInTenant(
      actor.accountId,
      tenant.schoolId,
      ['str-001:admin', 'str-001:write'],
    );
    if (!isAdmin) {
      throw new ForbiddenException('Customers may only manage their own wishlist');
    }
  }

  async listForCustomer(
    actor: ResolvedActor,
    customerPersonId: string,
  ): Promise<WishlistEntryDto[]> {
    await assertStoreCustomer(actor, this.permCheck, 'Wishlist list');
    await this.assertCanActFor(actor, customerPersonId);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT w.id::text AS id,
                w.customer_person_id::text AS customer_person_id,
                w.product_id::text AS product_id,
                w.notify_on_restock,
                w.created_at::text AS created_at
           FROM str_wishlists w
           JOIN str_products p ON p.id = w.product_id
           JOIN str_stores s ON s.id = p.store_id
          WHERE s.school_id = $1::uuid
            AND w.customer_person_id = $2::uuid
          ORDER BY w.created_at DESC`,
        tenant.schoolId,
        customerPersonId,
      )) as WishlistRow[];
      return rows.map((r) => this.toDto(r));
    });
  }

  async add(
    actor: ResolvedActor,
    customerPersonId: string,
    input: AddWishlistDto,
  ): Promise<WishlistEntryDto> {
    await assertStoreCustomer(actor, this.permCheck, 'Wishlist add');
    await this.assertCanActFor(actor, customerPersonId);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const productRows = (await tx.$queryRawUnsafe(
        `SELECT 1 AS ok
           FROM str_products p
           JOIN str_stores s ON s.id = p.store_id
          WHERE p.id = $1::uuid AND s.school_id = $2::uuid`,
        input.productId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (productRows.length === 0) {
        throw new BadRequestException('productId does not match a product in this school');
      }
      const id = generateId();
      try {
        const rows = (await tx.$queryRawUnsafe(
          `INSERT INTO str_wishlists
             (id, customer_person_id, product_id, notify_on_restock)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
           RETURNING id::text AS id,
                     customer_person_id::text AS customer_person_id,
                     product_id::text AS product_id,
                     notify_on_restock,
                     created_at::text AS created_at`,
          id,
          customerPersonId,
          input.productId,
          input.notifyOnRestock ?? true,
        )) as WishlistRow[];
        return this.toDto(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Idempotent — return the existing row.
          const existing = (await tx.$queryRawUnsafe(
            `SELECT id::text AS id,
                    customer_person_id::text AS customer_person_id,
                    product_id::text AS product_id,
                    notify_on_restock,
                    created_at::text AS created_at
               FROM str_wishlists
              WHERE customer_person_id = $1::uuid AND product_id = $2::uuid`,
            customerPersonId,
            input.productId,
          )) as WishlistRow[];
          if (existing.length === 0) {
            throw new ConflictException('Wishlist entry already exists');
          }
          return this.toDto(existing[0]!);
        }
        throw err;
      }
    });
  }

  async update(
    actor: ResolvedActor,
    customerPersonId: string,
    productId: string,
    input: UpdateWishlistDto,
  ): Promise<WishlistEntryDto> {
    await assertStoreCustomer(actor, this.permCheck, 'Wishlist update');
    await this.assertCanActFor(actor, customerPersonId);
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE str_wishlists
            SET notify_on_restock = $1
          WHERE customer_person_id = $2::uuid AND product_id = $3::uuid
          RETURNING id::text AS id,
                    customer_person_id::text AS customer_person_id,
                    product_id::text AS product_id,
                    notify_on_restock,
                    created_at::text AS created_at`,
        input.notifyOnRestock,
        customerPersonId,
        productId,
      )) as WishlistRow[];
      if (rows.length === 0) throw new NotFoundException('Wishlist entry not found');
      return this.toDto(rows[0]!);
    });
  }

  async remove(actor: ResolvedActor, customerPersonId: string, productId: string): Promise<void> {
    await assertStoreCustomer(actor, this.permCheck, 'Wishlist remove');
    await this.assertCanActFor(actor, customerPersonId);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM str_wishlists
          WHERE customer_person_id = $1::uuid AND product_id = $2::uuid`,
        customerPersonId,
        productId,
      );
    });
  }
}
