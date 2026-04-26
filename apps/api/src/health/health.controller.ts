import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import type { HealthStatus } from '@campusos/shared';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly startTime = Date.now();

  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check' })
  getHealth(): HealthStatus {
    return {
      status: 'healthy',
      version: '0.1.0',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      checks: {
        database: 'up',
        redis: 'up',
        kafka: 'up',
      },
    };
  }
}
