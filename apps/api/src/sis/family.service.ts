import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { GuardianResponseDto, StudentGuardianDto } from './dto/guardian.dto';

interface StudentGuardianRow {
  id: string;
  person_id: string;
  account_id: string | null;
  email: string | null;
  first_name: string;
  last_name: string;
  relationship: string;
  preferred_contact_method: string;
  family_id: string | null;
  has_custody: boolean;
  is_emergency_contact: boolean;
  receives_reports: boolean;
  portal_access: boolean;
  portal_access_scope: string;
}

@Injectable()
export class FamilyService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Guardians associated with a given student (via sis_student_guardians).
   * Each row carries the guardian fields plus the per-link booleans (has_custody, etc.).
   */
  async getStudentGuardians(studentId: string): Promise<StudentGuardianDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<StudentGuardianRow[]>(
        'SELECT g.id, g.person_id, g.account_id, g.relationship, g.preferred_contact_method, g.family_id, ' +
          'sg.has_custody, sg.is_emergency_contact, sg.receives_reports, sg.portal_access, sg.portal_access_scope, ' +
          'ip.first_name, ip.last_name, u.email ' +
          'FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'JOIN platform.iam_person ip ON ip.id = g.person_id ' +
          'LEFT JOIN platform.platform_users u ON u.id = g.account_id ' +
          'WHERE sg.student_id = $1::uuid ' +
          'ORDER BY ip.last_name, ip.first_name',
        studentId,
      );
    });
    return rows.map(function (r) {
      return {
        id: r.id,
        personId: r.person_id,
        accountId: r.account_id,
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name,
        fullName: r.first_name + ' ' + r.last_name,
        relationship: r.relationship,
        preferredContactMethod: r.preferred_contact_method,
        familyId: r.family_id,
        hasCustody: r.has_custody,
        isEmergencyContact: r.is_emergency_contact,
        receivesReports: r.receives_reports,
        portalAccess: r.portal_access,
        portalAccessScope: r.portal_access_scope,
      };
    });
  }

  async getById(guardianId: string): Promise<GuardianResponseDto | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<StudentGuardianRow[]>(
        'SELECT g.id, g.person_id, g.account_id, g.relationship, g.preferred_contact_method, g.family_id, ' +
          'false AS has_custody, false AS is_emergency_contact, false AS receives_reports, ' +
          "false AS portal_access, 'FULL' AS portal_access_scope, " +
          'ip.first_name, ip.last_name, u.email ' +
          'FROM sis_guardians g ' +
          'JOIN platform.iam_person ip ON ip.id = g.person_id ' +
          'LEFT JOIN platform.platform_users u ON u.id = g.account_id ' +
          'WHERE g.id = $1::uuid',
        guardianId,
      );
    });
    if (rows.length === 0) return null;
    var r = rows[0]!;
    return {
      id: r.id,
      personId: r.person_id,
      accountId: r.account_id,
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name,
      fullName: r.first_name + ' ' + r.last_name,
      relationship: r.relationship,
      preferredContactMethod: r.preferred_contact_method,
      familyId: r.family_id,
    };
  }
}
