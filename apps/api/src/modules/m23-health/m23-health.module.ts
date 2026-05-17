import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { HealthRecordsModule } from './health/health-records.module';
import { HealthAdvancedModule } from './health-advanced/health-advanced.module';

/**
 * M23 Health — canonical aggregator for health core (visits, IEP),
 * health records (immunisations, dietary), and health-advanced
 * (telehealth, compliance, screenings).
 */
@Module({
  imports: [HealthModule, HealthRecordsModule, HealthAdvancedModule],
  exports: [HealthModule, HealthRecordsModule, HealthAdvancedModule],
})
export class M23HealthModule {}
