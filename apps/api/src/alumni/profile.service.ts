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
import {
  hasStaffScope,
  isUniqueViolation,
  loadAlumniProfileOrFail,
  resolveOwnAlumniId,
} from './access';
import {
  AddTagDto,
  AlumniProfileDto,
  AlumniTagDto,
  CreateAlumniProfileDto,
  UpdateAlumniProfileDto,
} from './dto/alumni.dto';

interface ProfileRow {
  id: string;
  school_id: string;
  person_id: string;
  graduation_year: number;
  degree_programme: string | null;
  current_employer: string | null;
  current_title: string | null;
  linkedin_url: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  is_opted_in: boolean;
  display_name: string | null;
  tags: string[] | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_PROFILE_BASE =
  `SELECT p.id::text AS id, p.school_id::text AS school_id, p.person_id::text AS person_id, ` +
  `p.graduation_year, p.degree_programme, p.current_employer, p.current_title, p.linkedin_url, ` +
  `p.contact_email, p.contact_phone, p.is_opted_in, ` +
  `(ip.first_name || ' ' || ip.last_name) AS display_name, ` +
  `ARRAY(SELECT tag FROM alm_alumni_tags t WHERE t.alumni_id = p.id ORDER BY t.created_at) AS tags, ` +
  `p.created_at, p.updated_at ` +
  `FROM alm_alumni_profiles p ` +
  `LEFT JOIN platform.iam_person ip ON ip.id = p.person_id `;

function rowToDto(r: ProfileRow): AlumniProfileDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    personId: r.person_id,
    displayName: r.display_name ?? '',
    graduationYear: r.graduation_year,
    degreeProgramme: r.degree_programme,
    currentEmployer: r.current_employer,
    currentTitle: r.current_title,
    linkedinUrl: r.linkedin_url,
    contactEmail: r.contact_email,
    contactPhone: r.contact_phone,
    isOptedIn: r.is_opted_in,
    tags: r.tags ?? [],
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

@Injectable()
export class AlumniProfileService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * List the alumni directory. RLS — non-admin / non-staff readers see
   * opted-in profiles only. Admins + staff see every row. Optional
   * filters: graduation year, employer substring, tag.
   */
  async list(
    actor: ResolvedActor,
    filters: { graduationYear?: number; employer?: string; tag?: string } = {},
  ): Promise<AlumniProfileDto[]> {
    const tenant = getCurrentTenant();
    const isStaff = await hasStaffScope(this.permCheck, actor);

    const where: string[] = ['p.school_id = $1::uuid'];
    const args: unknown[] = [tenant.schoolId];

    if (!isStaff) {
      // Non-staff non-admin readers see opted-in only, EXCEPT the
      // calling alumnus's own row regardless of opt-in state.
      where.push(`(p.is_opted_in = true OR p.person_id = $${args.length + 1}::uuid)`);
      args.push(actor.personId);
    }
    if (filters.graduationYear !== undefined) {
      where.push(`p.graduation_year = $${args.length + 1}::int`);
      args.push(filters.graduationYear);
    }
    if (filters.employer !== undefined && filters.employer.length > 0) {
      where.push(`p.current_employer ILIKE $${args.length + 1}`);
      args.push('%' + filters.employer + '%');
    }
    if (filters.tag !== undefined && filters.tag.length > 0) {
      where.push(
        `EXISTS (SELECT 1 FROM alm_alumni_tags t WHERE t.alumni_id = p.id AND t.tag = $${args.length + 1})`,
      );
      args.push(filters.tag);
    }

    const sql =
      SELECT_PROFILE_BASE +
      'WHERE ' +
      where.join(' AND ') +
      ' ORDER BY p.graduation_year DESC, ip.last_name NULLS LAST, ip.first_name NULLS LAST';

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...args);
    })) as ProfileRow[];
    return rows.map(rowToDto);
  }

  /**
   * Get a profile by id with row-scope. Non-staff non-admin callers
   * may read OWN row at any opt-in state, OPTED-IN rows by other
   * alumni, and nothing else (404 don't-leak-existence).
   */
  async getById(id: string, actor: ResolvedActor): Promise<AlumniProfileDto> {
    const profile = await loadAlumniProfileOrFail(this.tenantPrisma, id);
    const isStaff = await hasStaffScope(this.permCheck, actor);

    if (!isStaff && !profile.isOptedIn && profile.personId !== actor.personId) {
      // Hide existence — opt-out is private.
      throw new NotFoundException('Alumni profile not found');
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_PROFILE_BASE + 'WHERE p.id = $1::uuid LIMIT 1', id);
    })) as ProfileRow[];
    if (rows.length === 0) {
      throw new NotFoundException('Alumni profile not found');
    }
    return rowToDto(rows[0]!);
  }

  /**
   * Resolve the calling actor's own alumni profile. 404 when the actor
   * is not registered as an alumnus at this school.
   */
  async getMine(actor: ResolvedActor): Promise<AlumniProfileDto> {
    const ownId = await resolveOwnAlumniId(this.tenantPrisma, actor);
    if (!ownId) {
      throw new NotFoundException('No alumni profile registered for this account');
    }
    return this.getById(ownId, actor);
  }

  /**
   * Create an alumni profile. RLS — non-staff callers may create only
   * their OWN profile (personId === actor.personId). Staff + admin may
   * create on behalf of any platform.iam_person. UNIQUE(school_id,
   * person_id) on the schema is the dedup gate; the service surfaces a
   * friendly 409 on collision.
   */
  async create(input: CreateAlumniProfileDto, actor: ResolvedActor): Promise<AlumniProfileDto> {
    const tenant = getCurrentTenant();
    const isStaff = await hasStaffScope(this.permCheck, actor);

    if (!isStaff && input.personId !== actor.personId) {
      throw new ForbiddenException(
        'Only staff or admin may create an alumni profile on behalf of another user.',
      );
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO alm_alumni_profiles
             (id, school_id, person_id, graduation_year, degree_programme, current_employer,
              current_title, linkedin_url, contact_email, contact_phone, is_opted_in)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6, $7, $8, $9, $10, $11)`,
          id,
          tenant.schoolId,
          input.personId,
          input.graduationYear,
          input.degreeProgramme ?? null,
          input.currentEmployer ?? null,
          input.currentTitle ?? null,
          input.linkedinUrl ?? null,
          input.contactEmail ?? null,
          input.contactPhone ?? null,
          input.isOptedIn ?? true,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'An alumni profile already exists for this person at this school. Use PATCH to update it.',
        );
      }
      throw err;
    }

    return this.getById(id, actor);
  }

  /**
   * Update an alumni profile. RLS — non-staff callers may update only
   * their OWN profile. Staff + admin may update any profile.
   */
  async patch(
    id: string,
    input: UpdateAlumniProfileDto,
    actor: ResolvedActor,
  ): Promise<AlumniProfileDto> {
    const profile = await loadAlumniProfileOrFail(this.tenantPrisma, id);
    const isStaff = await hasStaffScope(this.permCheck, actor);
    const isOwner = profile.personId === actor.personId;

    if (!isStaff && !isOwner) {
      // Don't leak existence to non-owners outside staff.
      throw new NotFoundException('Alumni profile not found');
    }

    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [];
    let i = 1;
    const add = (col: string, val: unknown) => {
      sets.push(`${col} = $${i++}`);
      args.push(val);
    };
    if (input.degreeProgramme !== undefined) add('degree_programme', input.degreeProgramme);
    if (input.currentEmployer !== undefined) add('current_employer', input.currentEmployer);
    if (input.currentTitle !== undefined) add('current_title', input.currentTitle);
    if (input.linkedinUrl !== undefined) add('linkedin_url', input.linkedinUrl);
    if (input.contactEmail !== undefined) add('contact_email', input.contactEmail);
    if (input.contactPhone !== undefined) add('contact_phone', input.contactPhone);
    if (input.isOptedIn !== undefined) add('is_opted_in', input.isOptedIn);

    if (args.length === 0 && sets.length === 1) {
      // No changes — just return current state.
      return this.getById(id, actor);
    }

    args.push(id);
    const sql = `UPDATE alm_alumni_profiles SET ${sets.join(', ')} WHERE id = $${i}::uuid`;

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(sql, ...args);
    });
    return this.getById(id, actor);
  }
}

@Injectable()
export class AlumniTagService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * Add a tag to an alumni profile. Non-staff callers may tag only
   * their OWN profile (self-tag for mentorship interests). Staff +
   * admin may tag any profile (campaign segmentation).
   */
  async addTag(input: AddTagDto, actor: ResolvedActor): Promise<AlumniTagDto> {
    const profile = await loadAlumniProfileOrFail(this.tenantPrisma, input.alumniId);
    const isStaff = await hasStaffScope(this.permCheck, actor);

    if (!isStaff && profile.personId !== actor.personId) {
      throw new ForbiddenException(
        'Only staff or admin may tag another alumnus. You may tag your own profile.',
      );
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO alm_alumni_tags (id, alumni_id, tag) VALUES ($1::uuid, $2::uuid, $3)',
          id,
          input.alumniId,
          input.tag,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('This tag is already applied to this alumnus.');
      }
      throw err;
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, alumni_id::text AS alumni_id, tag, created_at
         FROM alm_alumni_tags WHERE id = $1::uuid LIMIT 1`,
        id,
      );
    })) as Array<{ id: string; alumni_id: string; tag: string; created_at: Date }>;
    const r = rows[0]!;
    return {
      id: r.id,
      alumniId: r.alumni_id,
      tag: r.tag,
      createdAt: r.created_at.toISOString(),
    };
  }

  /**
   * Remove a tag by id. Non-staff callers may remove only tags on their
   * OWN profile. Staff + admin may remove any tag.
   */
  async removeTag(tagId: string, actor: ResolvedActor): Promise<void> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT t.id::text AS id, p.person_id::text AS person_id
         FROM alm_alumni_tags t JOIN alm_alumni_profiles p ON p.id = t.alumni_id
         WHERE t.id = $1::uuid LIMIT 1`,
        tagId,
      );
    })) as Array<{ id: string; person_id: string }>;
    if (rows.length === 0) {
      throw new NotFoundException('Tag not found');
    }
    const tag = rows[0]!;
    const isStaff = await hasStaffScope(this.permCheck, actor);
    if (!isStaff && tag.person_id !== actor.personId) {
      // Use 404 don't-leak-existence for non-owners.
      throw new NotFoundException('Tag not found');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe('DELETE FROM alm_alumni_tags WHERE id = $1::uuid', tagId);
    });
  }

  /**
   * List alumni who carry a given tag — the segmentation query. The
   * Step 5 CampaignService.addRecipientsByTag joins on this list to
   * bulk-create alm_campaign_recipients.
   */
  async listByTag(tag: string, actor: ResolvedActor): Promise<AlumniProfileDto[]> {
    if (!tag || typeof tag !== 'string' || tag.length === 0) {
      throw new BadRequestException('tag is required');
    }
    const tenant = getCurrentTenant();
    const isStaff = await hasStaffScope(this.permCheck, actor);

    const where: string[] = [
      'p.school_id = $1::uuid',
      `EXISTS (SELECT 1 FROM alm_alumni_tags t WHERE t.alumni_id = p.id AND t.tag = $2)`,
    ];
    const args: unknown[] = [tenant.schoolId, tag];
    if (!isStaff) {
      where.push(`(p.is_opted_in = true OR p.person_id = $${args.length + 1}::uuid)`);
      args.push(actor.personId);
    }
    const sql =
      SELECT_PROFILE_BASE + 'WHERE ' + where.join(' AND ') + ' ORDER BY p.graduation_year DESC';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...args);
    })) as ProfileRow[];
    return rows.map(rowToDto);
  }
}
