import { Module } from '@nestjs/common';
import { SisModule } from './students/sis.module';
import { AttendanceModule } from './attendance/attendance.module';
import { SisAdvancedModule } from './students/sis-advanced.module';
import { SisGraduationModule } from './graduation/sis-graduation.module';
import { SisTranscriptsModule } from './transcripts/sis-transcripts.module';

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
