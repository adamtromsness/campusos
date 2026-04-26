import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { HealthStatus } from '@campusos/shared';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly startTime = Date.now();

  @Get()
  @ApiOperation({ summary: 'Health check — returns API status and dependency health' })
  getHealth(): HealthStatus {
    return {
      status: 'healthy',
      version: '0.1.0',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      checks: {
        database: 'up', // TODO: actual check in Step 4
        redis: 'up', // TODO: actual check in Step 6
        kafka: 'up', // TODO: actual check in Step 6
      },
    };
  }
}
