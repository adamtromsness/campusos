import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { PlatformModule } from './platform/platform.module';
import { IamModule } from './iam/iam.module';

/**
 * CampusOS Root Application Module
 *
 * Module structure mirrors the ERD module architecture:
 * - PlatformModule (M0) — identity, tenancy, infrastructure
 * - IamModule (M0/IAM) — roles, permissions, access control
 *
 * Each build cycle adds a new module:
 * - Cycle 1: SisModule (M20), AttendanceModule (M20)
 * - Cycle 2: ClassroomModule (M21)
 * - Cycle 3: CommunicationsModule (M40)
 * - etc.
 */
@Module({
  imports: [
    // Environment configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Health check endpoint (no auth required)
    HealthModule,

    // M0 Platform Core — identity, tenancy, audit
    PlatformModule,

    // M0 IAM — roles, permissions, assignments, access cache
    IamModule,

    // Future modules added here per build cycle:
    // SisModule,           // Cycle 1
    // ClassroomModule,     // Cycle 2
    // CommunicationsModule,// Cycle 3
    // HrModule,            // Cycle 4
    // EnrolmentModule,     // Cycle 5
    // PaymentsModule,      // Cycle 5
  ],
})
export class AppModule {}
