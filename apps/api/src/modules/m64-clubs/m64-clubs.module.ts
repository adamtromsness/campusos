import { Module } from '@nestjs/common';
import { ClubsModule } from './clubs/clubs.module';

/**
 * M64 Clubs & Student Life — canonical aggregator.
 */
@Module({
  imports: [ClubsModule],
  exports: [ClubsModule],
})
export class M64ClubsModule {}
