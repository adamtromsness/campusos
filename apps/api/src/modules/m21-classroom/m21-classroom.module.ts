import { Module } from '@nestjs/common';
import { ClassroomModule } from './classroom/classroom.module';
import { ClassroomAdvancedModule } from './classroom-advanced/classroom-advanced.module';

/**
 * M21 Classroom — canonical aggregator for classroom core (classes,
 * lessons, assignments, grading) and classroom-advanced (AI tutoring,
 * hall passes, peer review, progress notes, report cards, video).
 */
@Module({
  imports: [ClassroomModule, ClassroomAdvancedModule],
  exports: [ClassroomModule, ClassroomAdvancedModule],
})
export class M21ClassroomModule {}
