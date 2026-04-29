import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { StudentService } from './student.service';
import { ClassService } from './class.service';
import { FamilyService } from './family.service';
import { StudentController } from './student.controller';
import { ClassController } from './class.controller';
import { AcademicYearController } from './academic-year.controller';

/**
 * SIS Module — Student Information System (M20 SIS Core)
 *
 * The first domain module in the modular monolith. Provides student, class,
 * and family/guardian queries against the tenant SIS schema. Other modules
 * (Attendance in particular) consume StudentService and ClassService.
 *
 * All endpoints are tenant-scoped via TenantPrismaService.executeInTenantContext
 * and protected with @RequirePermission. Per ADR-055, identity fields
 * (firstName/lastName/dateOfBirth) live in iam_person and are joined in at
 * read time — never duplicated in sis_* tables.
 */
@Module({
  imports: [TenantModule, IamModule],
  providers: [StudentService, ClassService, FamilyService],
  controllers: [StudentController, ClassController, AcademicYearController],
  exports: [StudentService, ClassService, FamilyService],
})
export class SisModule {}
