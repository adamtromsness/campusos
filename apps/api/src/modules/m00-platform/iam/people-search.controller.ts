import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PeopleSearchResult, PeopleSearchService } from './people-search.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

/**
 * GET /people/search — small name + email lookup used by the
 * emergency-contact link-to-user flow on /family/settings. Auth-only
 * (no @RequirePermission) — every authenticated user can resolve a
 * name to find someone to link as an emergency contact. The PII
 * exposure is minimal (name, email, phone) and is gated by knowing
 * enough about the target to type a usable query.
 */
@ApiTags('People')
@ApiBearerAuth()
@Controller('people')
export class PeopleSearchController {
  constructor(private readonly people: PeopleSearchService) {}

  @Get('search')
  @ApiOperation({
    summary:
      'Name + email lookup over iam_person, JOIN platform_users. Excludes the caller; capped at 10 results.',
  })
  async search(@Req() req: AuthedRequest, @Query('q') q: string): Promise<PeopleSearchResult[]> {
    return this.people.search(req.user!.personId, q ?? '');
  }
}
