import { Module } from '@nestjs/common';
import { SisModule } from './sis/sis.module';
import { AttendanceModule } from './attendance/attendance.module';
import { SisAdvancedModule } from './sis-advanced/sis-advanced.module';
import { SisGraduationModule } from './sis-graduation/sis-graduation.module';
import { SisTranscriptsModule } from './sis-transcripts/sis-transcripts.module';

/**
 * M20 SIS — canonical aggregator for the Student Information System
 * (core students/guardians/family, attendance, advanced custom fields
 * + notes + relationships, graduation tracking, transcripts).
 */
@Module({
  imports: [
    SisModule,
    AttendanceModule,
    SisAdvancedModule,
    SisGraduationModule,
    SisTranscriptsModule,
  ],
  exports: [
    SisModule,
    AttendanceModule,
    SisAdvancedModule,
    SisGraduationModule,
    SisTranscriptsModule,
  ],
})
export class M20SisModule {}
