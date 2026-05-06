import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { GroupService } from './group.service';
import { InitiateTransferDto, TransferResponseDto, TransferStatus } from './dto/groups.dto';

interface TransferRow {
  id: string;
  group_id: string;
  from_member_id: string;
  from_name: string | null;
  to_member_id: string;
  to_name: string | null;
  transfer_reason: string | null;
  status: string;
  initiated_at: Date;
  expires_at: Date;
  responded_at: Date | null;
}

const SELECT_TRANSFER_BASE =
  'SELECT t.id::text AS id, t.group_id::text AS group_id, ' +
  't.from_member_id::text AS from_member_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM grp_members fm " +
  '  JOIN platform.platform_users pu ON pu.id = fm.person_id ' +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE fm.id = t.from_member_id) AS from_name, ' +
  't.to_member_id::text AS to_member_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM grp_members tm " +
  '  JOIN platform.platform_users pu ON pu.id = tm.person_id ' +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE tm.id = t.to_member_id) AS to_name, ' +
  't.transfer_reason, t.status, t.initiated_at, t.expires_at, t.responded_at ' +
  'FROM grp_ownership_transfers t ';

function rowToDto(r: TransferRow): TransferResponseDto {
  return {
    id: r.id,
    groupId: r.group_id,
    fromMemberId: r.from_member_id,
    fromName: r.from_name,
    toMemberId: r.to_member_id,
    toName: r.to_name,
    reason: r.transfer_reason,
    status: r.status as TransferStatus,
    initiatedAt: r.initiated_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    respondedAt: r.responded_at ? r.responded_at.toISOString() : null,
  };
}

@Injectable()
export class OwnershipTransferService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly groups: GroupService,
  ) {}

  /**
   * Initiate a transfer. Requires:
   *  1. Caller holds an OWNER row on the group.
   *  2. The destination member is ACTIVE (not LEFT, not SUSPENDED).
   *  3. No existing PENDING transfer for this group (partial UNIQUE
   *     enforces this at the schema layer; we surface a 400).
   *  4. from <> to (schema CHECK).
   */
  async initiate(
    groupId: string,
    input: InitiateTransferDto,
    actor: ResolvedActor,
  ): Promise<TransferResponseDto> {
    await this.groups.assertOwner(groupId, actor.accountId);

    // Locate the from-member row (caller's OWNER row).
    const fromRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT id::text AS id FROM grp_members WHERE group_id = $1::uuid AND person_id = $2::uuid AND member_role = 'OWNER' AND status = 'ACTIVE' LIMIT 1",
        groupId,
        actor.accountId,
      );
    })) as Array<{ id: string }>;
    if (fromRows.length === 0) {
      throw new ForbiddenException('Caller is not the OWNER of this group');
    }
    const fromMemberId = fromRows[0]!.id;

    // Validate the destination row exists, is ACTIVE, and on the same group.
    const toRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, status, group_id::text AS group_id FROM grp_members WHERE id = $1::uuid LIMIT 1',
        input.toMemberId,
      );
    })) as Array<{ id: string; status: string; group_id: string }>;
    if (toRows.length === 0) throw new NotFoundException('Destination member not found');
    if (toRows[0]!.group_id !== groupId) {
      throw new BadRequestException('Destination member does not belong to this group');
    }
    if (toRows[0]!.status !== 'ACTIVE') {
      throw new BadRequestException('Destination member must be ACTIVE');
    }
    if (toRows[0]!.id === fromMemberId) {
      throw new BadRequestException('Cannot transfer to yourself');
    }

    const expiryHours = input.expiryHours ?? 168;
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO grp_ownership_transfers (id, group_id, from_member_id, to_member_id, transfer_reason, status, expires_at) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'PENDING', now() + ($6 || ' hours')::interval)",
          id,
          groupId,
          fromMemberId,
          input.toMemberId,
          input.reason ?? null,
          expiryHours,
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (err.code === '23505' || /duplicate|already exists/i.test(err.message ?? '')) {
        throw new BadRequestException(
          'A pending ownership transfer already exists for this group — cancel it before initiating another',
        );
      }
      throw e;
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_TRANSFER_BASE + 'WHERE t.id = $1::uuid LIMIT 1', id);
    })) as TransferRow[];
    return rowToDto(rows[0]!);
  }

  async list(groupId: string, actor: ResolvedActor): Promise<TransferResponseDto[]> {
    // The group read enforces visibility (INVITE_ONLY hidden).
    await this.groups.getById(groupId, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TRANSFER_BASE + 'WHERE t.group_id = $1::uuid ORDER BY t.initiated_at DESC',
        groupId,
      );
    })) as TransferRow[];
    return rows.map(rowToDto);
  }

  async listMine(actor: ResolvedActor): Promise<TransferResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TRANSFER_BASE +
          "WHERE t.status = 'PENDING' AND t.to_member_id IN (SELECT id FROM grp_members WHERE person_id = $1::uuid AND status = 'ACTIVE') " +
          'ORDER BY t.initiated_at DESC',
        actor.accountId,
      );
    })) as TransferRow[];
    return rows.map(rowToDto);
  }

  /**
   * KEYSTONE — accept a pending transfer.
   *
   * Inside one tenant transaction:
   *   1. Lock the transfer row, validate PENDING + not expired, and
   *      validate the caller is the to-member.
   *   2. Lock both grp_members rows (FROM old-OWNER, TO new-OWNER).
   *   3. Demote the from-member to ADMIN, promote the to-member to OWNER.
   *   4. Stamp transfer row ACCEPTED + responded_at = now() per the
   *      multi-column responded_chk lockstep.
   *
   * The atomic role swap inside one tx + the partial UNIQUE
   * (group_id) WHERE status='PENDING' is what makes the handshake
   * race-free.
   */
  async accept(transferId: string, actor: ResolvedActor): Promise<TransferResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const txRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, from_member_id::text AS from_member_id, to_member_id::text AS to_member_id, status, expires_at ' +
          'FROM grp_ownership_transfers WHERE id = $1::uuid FOR UPDATE',
        transferId,
      )) as Array<{
        id: string;
        group_id: string;
        from_member_id: string;
        to_member_id: string;
        status: string;
        expires_at: Date;
      }>;
      if (txRows.length === 0) throw new NotFoundException('Transfer not found');
      const t = txRows[0]!;
      if (t.status !== 'PENDING') {
        throw new BadRequestException('Transfer is not pending (status=' + t.status + ')');
      }
      if (t.expires_at.getTime() < Date.now()) {
        await tx.$executeRawUnsafe(
          "UPDATE grp_ownership_transfers SET status = 'EXPIRED', responded_at = now(), updated_at = now() WHERE id = $1::uuid",
          transferId,
        );
        throw new BadRequestException('Transfer has expired');
      }

      const toRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, person_id::text AS person_id, status FROM grp_members WHERE id = $1::uuid FOR UPDATE',
        t.to_member_id,
      )) as Array<{ id: string; person_id: string; status: string }>;
      if (toRows.length === 0 || toRows[0]!.person_id !== actor.accountId) {
        throw new ForbiddenException('Only the named recipient can accept this transfer');
      }
      if (toRows[0]!.status !== 'ACTIVE') {
        throw new BadRequestException('Recipient is no longer ACTIVE');
      }

      const fromRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM grp_members WHERE id = $1::uuid FOR UPDATE',
        t.from_member_id,
      )) as Array<{ id: string; status: string }>;
      if (fromRows.length === 0) {
        throw new BadRequestException('Original owner row no longer exists');
      }

      // Atomic role swap.
      await tx.$executeRawUnsafe(
        "UPDATE grp_members SET member_role = 'ADMIN', updated_at = now() WHERE id = $1::uuid",
        t.from_member_id,
      );
      await tx.$executeRawUnsafe(
        "UPDATE grp_members SET member_role = 'OWNER', updated_at = now() WHERE id = $1::uuid",
        t.to_member_id,
      );
      await tx.$executeRawUnsafe(
        "UPDATE grp_ownership_transfers SET status = 'ACCEPTED', responded_at = now(), updated_at = now() WHERE id = $1::uuid",
        transferId,
      );
    });

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TRANSFER_BASE + 'WHERE t.id = $1::uuid LIMIT 1',
        transferId,
      );
    })) as TransferRow[];
    return rowToDto(rows[0]!);
  }

  async decline(transferId: string, actor: ResolvedActor): Promise<TransferResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT t.id, t.status, m.person_id::text AS to_person_id ' +
          'FROM grp_ownership_transfers t ' +
          'JOIN grp_members m ON m.id = t.to_member_id ' +
          'WHERE t.id = $1::uuid FOR UPDATE OF t',
        transferId,
      )) as Array<{ id: string; status: string; to_person_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Transfer not found');
      if (rows[0]!.to_person_id !== actor.accountId) {
        throw new ForbiddenException('Only the named recipient can decline this transfer');
      }
      if (rows[0]!.status !== 'PENDING') {
        throw new BadRequestException('Transfer is not pending');
      }
      await tx.$executeRawUnsafe(
        "UPDATE grp_ownership_transfers SET status = 'DECLINED', responded_at = now(), updated_at = now() WHERE id = $1::uuid",
        transferId,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TRANSFER_BASE + 'WHERE t.id = $1::uuid LIMIT 1',
        transferId,
      );
    })) as TransferRow[];
    return rowToDto(rows[0]!);
  }

  async cancel(transferId: string, actor: ResolvedActor): Promise<TransferResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT t.id, t.status, t.group_id::text AS group_id, fm.person_id::text AS from_person_id ' +
          'FROM grp_ownership_transfers t ' +
          'JOIN grp_members fm ON fm.id = t.from_member_id ' +
          'WHERE t.id = $1::uuid FOR UPDATE OF t',
        transferId,
      )) as Array<{ id: string; status: string; group_id: string; from_person_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Transfer not found');
      if (rows[0]!.from_person_id !== actor.accountId && !actor.isSchoolAdmin) {
        throw new ForbiddenException('Only the initiator or a school admin can cancel');
      }
      if (rows[0]!.status !== 'PENDING') {
        throw new BadRequestException('Transfer is not pending');
      }
      await tx.$executeRawUnsafe(
        "UPDATE grp_ownership_transfers SET status = 'CANCELLED', responded_at = now(), updated_at = now() WHERE id = $1::uuid",
        transferId,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TRANSFER_BASE + 'WHERE t.id = $1::uuid LIMIT 1',
        transferId,
      );
    })) as TransferRow[];
    return rowToDto(rows[0]!);
  }
}
