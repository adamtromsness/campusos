import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { AssignmentService } from './assignment.service';
import { CategoryService } from './category.service';
import { AssignmentController } from './assignment.controller';
import { CategoryController } from './category.controller';

/**
 * ClassroomModule — M21 Classroom (Cycle 2).
 *
 * Step 4 lands assignment + category management. Step 5 will add submissions
 * and grading services on top; Step 6 wires the gradebook snapshot Kafka
 * consumer.
 *
 * Row-level authorisation is delegated to ActorContextService (from IamModule)
 * — assignments are visible to teachers of the class, admins, enrolled
 * students, and linked guardians; writes are restricted to teachers-of-class
 * and admins (the per-class membership check mirrors AttendanceService).
 */
@Module({
  imports: [TenantModule, IamModule],
  providers: [AssignmentService, CategoryService],
  controllers: [AssignmentController, CategoryController],
  exports: [AssignmentService, CategoryService],
})
export class ClassroomModule {}
