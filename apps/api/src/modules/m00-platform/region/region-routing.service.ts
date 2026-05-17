import { Injectable, Logger } from '@nestjs/common';

/**
 * Cycle 32 Step 6 — Region Routing Service.
 *
 * Resolves the regional database / Kafka / Redis endpoints for a
 * given tenant home_region. Application code uses this when it needs
 * to reach a regional dependency (rare today — the
 * RegionMismatchInterceptor catches misrouted requests before the
 * service layer touches a wrong-region resource).
 *
 * The Cycle 31 Step 9 Platform Admin dashboard reads this service to
 * surface regional endpoints in the tenant detail view (Phase 2 UI
 * work).
 */
@Injectable()
export class RegionRoutingService {
  private readonly logger = new Logger(RegionRoutingService.name);

  /**
   * Map a tenant's home_region to the canonical regional endpoint
   * environment variables. Production wires these via the deployment-
   * time secrets backend; local dev returns the single-region defaults.
   */
  resolveDatabaseEndpoint(homeRegion: string): string {
    switch (homeRegion) {
      case 'us-east-1':
        return process.env.RDS_PRIMARY_ENDPOINT_US_EAST_1 ?? process.env.DATABASE_URL ?? '';
      case 'us-west-2':
        return process.env.RDS_STANDBY_ENDPOINT_US_WEST_2 ?? process.env.DATABASE_URL ?? '';
      case 'eu-west-2':
        return process.env.RDS_PRIMARY_ENDPOINT_EU_WEST_2 ?? process.env.DATABASE_URL ?? '';
      case 'eu-west-1':
        return process.env.RDS_STANDBY_ENDPOINT_EU_WEST_1 ?? process.env.DATABASE_URL ?? '';
      default:
        this.logger.warn(`Unknown home_region: ${homeRegion}; falling back to default.`);
        return process.env.DATABASE_URL ?? '';
    }
  }

  resolveKafkaBrokers(homeRegion: string): string {
    switch (homeRegion) {
      case 'us-east-1':
        return process.env.KAFKA_BROKERS_US_EAST_1 ?? process.env.KAFKA_BROKERS ?? '';
      case 'us-west-2':
        return process.env.KAFKA_BROKERS_US_WEST_2 ?? process.env.KAFKA_BROKERS ?? '';
      case 'eu-west-2':
        return process.env.KAFKA_BROKERS_EU_WEST_2 ?? process.env.KAFKA_BROKERS ?? '';
      case 'eu-west-1':
        return process.env.KAFKA_BROKERS_EU_WEST_1 ?? process.env.KAFKA_BROKERS ?? '';
      default:
        return process.env.KAFKA_BROKERS ?? '';
    }
  }

  resolveRedisEndpoint(homeRegion: string): string {
    switch (homeRegion) {
      case 'us-east-1':
        return process.env.REDIS_ENDPOINT_US_EAST_1 ?? process.env.REDIS_URL ?? '';
      case 'us-west-2':
        return process.env.REDIS_ENDPOINT_US_WEST_2 ?? process.env.REDIS_URL ?? '';
      case 'eu-west-2':
        return process.env.REDIS_ENDPOINT_EU_WEST_2 ?? process.env.REDIS_URL ?? '';
      case 'eu-west-1':
        return process.env.REDIS_ENDPOINT_EU_WEST_1 ?? process.env.REDIS_URL ?? '';
      default:
        return process.env.REDIS_URL ?? '';
    }
  }

  /**
   * The deployment region this process is running in. Used by the
   * RegionMismatchInterceptor to compare against the tenant's home
   * region. Returns null when AWS_REGION is unset (local dev / test).
   */
  getDeployedRegion(): string | null {
    return process.env.AWS_REGION ?? null;
  }

  /**
   * Returns true when the deployed region matches the supplied
   * home_region. The interceptor uses this for the gate; service
   * code uses it for guard branches that route a query to a regional
   * read replica vs the primary writer.
   */
  matchesDeployed(homeRegion: string): boolean {
    var deployed = this.getDeployedRegion();
    if (!deployed) return true; // local dev: never gate
    return deployed === homeRegion;
  }
}
