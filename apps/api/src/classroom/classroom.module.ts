import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { AssignmentService } from './assignment.service';
import { CategoryService } from './category.service';
import { SubmissionService } from './submission.service';
import { GradeService } from './grade.service';
import { GradebookService } from './gradebook.service';
import { ProgressNoteService } from './progress-note.service';
import { GradebookSnapshotWorker } from './gradebook-snapshot-worker.service';
import { AssignmentController } from './assignment.controller';
import { CategoryController } from './category.controller';
import { SubmissionController } from './submission.controller';
import { GradeController } from './grade.controller';
import { GradebookController } from './gradebook.controller';
import { ProgressNoteController } from './progress-note.controller';

/**
 * ClassroomModule — M21 Classroom (Cycle 2).
 *
 * Step 4 lands assignment + category management. Step 5 adds submissions,
 * grading (single + batch + publish), gradebook reads (class + student),
 * and progress notes. Step 6 wires GradebookSnapshotWorker — the first
 * Kafka consumer in the system — which listens to cls.grade.published /
 * cls.grade.unpublished and recomputes cls_gradebook_snapshots with a
 * 30-second debounce per (class_id, student_id). Idempotency is via
 * platform.platform_event_consumer_idempotency. Per ADR-010 the snapshot
 * table is never touched inside a grade-write transaction.
 *
 * Row-level authorisation is delegated to ActorContextService (from IamModule)
 * — assignments, submissions, grades, and progress notes are visible to
 * teachers of the class, admins, enrolled students, and linked guardians;
 * writes are restricted to teachers-of-class and admins for grading and
 * to enrolled students for their own submissions.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    AssignmentService,
    CategoryService,
    SubmissionService,
    GradeService,
    GradebookService,
    ProgressNoteService,
    GradebookSnapshotWorker,
  ],
  controllers: [
    AssignmentController,
    CategoryController,
    SubmissionController,
    GradeController,
    GradebookController,
    ProgressNoteController,
  ],
  exports: [
    AssignmentService,
    CategoryService,
    SubmissionService,
    GradeService,
    GradebookService,
    ProgressNoteService,
    GradebookSnapshotWorker,
  ],
})
export class ClassroomModule {}
