import { Module } from '@nestjs/common';
import { HealthModule } from './records/health.module';
import { HealthRecordsModule } from './records/health-records.module';
import { HealthAdvancedModule } from './records/health-advanced.module';

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
