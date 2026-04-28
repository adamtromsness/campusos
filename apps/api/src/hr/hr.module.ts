import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { EmployeeService } from './employee.service';
import { PositionService } from './position.service';
import { EmployeeDocumentService } from './employee-document.service';
import { EmployeeController } from './employee.controller';
import { PositionController } from './position.controller';

/**
 * HR Module — M80 Workforce Core (Cycle 4 Step 6).
 *
 * Provides employee directory, position catalogue, and per-employee document
 * management against the hr_* tenant tables that landed in Cycle 4 Steps 0–4.
 *
 * Authorisation contract:
 *   - hr-001:read   — Teacher / Staff / School Admin / Platform Admin can
 *                     read the staff directory and any employee profile.
 *                     Document access is row-scoped to "own profile or admin"
 *                     inside EmployeeDocumentService.
 *   - hr-001:write  — Document upload + admin-only employee CRUD.
 *   - hr-001:admin  — Position CRUD (admin scope is intentionally narrower
 *                     than write because positions are tenant-wide config).
 *
 * Step 7 will add LeaveService / CertificationService / TrainingComplianceService
 * + the leave-event Kafka consumer on top of this module.
 */
@Module({
  imports: [TenantModule, IamModule],
  providers: [EmployeeService, PositionService, EmployeeDocumentService],
  controllers: [EmployeeController, PositionController],
  exports: [EmployeeService, PositionService, EmployeeDocumentService],
})
export class HrModule {}
