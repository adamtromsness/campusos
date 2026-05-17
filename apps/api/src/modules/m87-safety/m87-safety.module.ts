import { Module } from '@nestjs/common';
import { IncidentsModule } from './incidents/incidents.module';

/**
 * M87 Safety & Emergency — canonical aggregator. Currently wraps the
 * incidents leaf (emergency declarations, incident timeline,
 * accountability + reunification, drills, non-discipline reports).
 */
@Module({
  imports: [IncidentsModule],
  exports: [IncidentsModule],
})
export class M87SafetyModule {}
