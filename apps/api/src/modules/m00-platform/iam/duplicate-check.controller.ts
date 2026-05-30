import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { DuplicateCheckService } from './duplicate-check.service';
import { CheckDuplicateDto, CheckDuplicateResultDto } from './dto/duplicate-check.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

/**
 * POST /people/check-duplicate — Account Creation spec, Step 3.
 *
 * Auth-only (no @RequirePermission): any authenticated user creating an
 * account may ask whether the person they're about to add already exists.
 * The disclosure is intentionally minimal (see CheckDuplicateResultDto)
 * and the service rate-limits + requires a strong match, so this can't be
 * used to enumerate accounts. POST (not GET) because the body carries
 * identity fields we'd rather not see logged in URLs / proxies.
 */
@ApiTags('People')
@ApiBearerAuth()
@Controller('people')
export class DuplicateCheckController {
  constructor(private readonly duplicates: DuplicateCheckService) {}

  @Post('check-duplicate')
  @ApiOperation({
    summary:
      'Privacy-safe duplicate detection. Strong match only (exact email OR name+DOB); returns a minimal descriptor, never PII. Rate-limited.',
  })
  async check(
    @Req() req: AuthedRequest,
    @Body() dto: CheckDuplicateDto,
  ): Promise<CheckDuplicateResultDto> {
    return this.duplicates.check(req.user!.personId, dto);
  }
}
