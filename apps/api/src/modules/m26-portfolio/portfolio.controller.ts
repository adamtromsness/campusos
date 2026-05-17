import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { Public } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { PortfolioService } from './portfolio.service';
import { ShareService } from './share.service';
import { AchievementService } from './achievement.service';
import {
  AchievementDto,
  AchievementShareDto,
  CreateAchievementDto,
  CreateAchievementShareDto,
  CreatePortfolioDto,
  CreatePortfolioItemDto,
  CreateShareDto,
  ItemSourceCandidateDto,
  PortfolioDetailDto,
  PortfolioDto,
  PortfolioItemDto,
  PublicPortfolioViewDto,
  ShareDto,
  UpdateAchievementDto,
  UpdatePortfolioDto,
  UpdatePortfolioItemDto,
} from './dto/portfolio.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Student Portfolio')
@Controller()
export class PortfolioController {
  constructor(
    private readonly portfolios: PortfolioService,
    private readonly shares: ShareService,
    private readonly achievements: AchievementService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached Portfolio controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ── Portfolio ─────────────────────────────────────────────

  @Get('portfolio/my')
  @RequirePermission('ach-002:read')
  @ApiOperation({
    summary:
      'STUDENT-OWNED — returns the calling student’s portfolio with items + visibility. Other personas use /portfolio/students/:studentId.',
  })
  async getMy(@Req() req: AuthedRequest): Promise<PortfolioDetailDto | null> {
    return this.portfolios.getMy(await this.resolveActor(req));
  }

  @Get('portfolio/students/:studentId')
  @RequirePermission('ach-002:read')
  @ApiOperation({
    summary:
      'Visibility-gated read. PRIVATE returns 404 for non-owner. TEACHER visible to staff. PARENT visible to staff + linked guardians. PUBLIC visible to all.',
  })
  async getByStudent(
    @Param('studentId') studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<PortfolioDetailDto | null> {
    return this.portfolios.getByStudent(await this.resolveActor(req), studentId);
  }

  @Post('portfolio')
  @RequirePermission('ach-002:write')
  async create(@Body() dto: CreatePortfolioDto, @Req() req: AuthedRequest): Promise<PortfolioDto> {
    return this.portfolios.create(await this.resolveActor(req), dto);
  }

  @Patch('portfolio/:id')
  @RequirePermission('ach-002:write')
  async patch(
    @Param('id') id: string,
    @Body() dto: UpdatePortfolioDto,
    @Req() req: AuthedRequest,
  ): Promise<PortfolioDto> {
    return this.portfolios.patch(await this.resolveActor(req), id, dto);
  }

  // ── Portfolio items ───────────────────────────────────────

  @Get('portfolio/:id/items')
  @RequirePermission('ach-002:read')
  @ApiOperation({
    summary:
      'List portfolio items — actor-aware (REVIEW-CYCLE24 BLOCKING 1). Inherits the parent portfolio visibility lattice; non-authorised callers get a collapsed 404.',
  })
  async listItems(@Param('id') id: string, @Req() req: AuthedRequest): Promise<PortfolioItemDto[]> {
    return this.portfolios.listItemsForPortfolio(id, await this.resolveActor(req));
  }

  @Post('portfolio/:id/items')
  @RequirePermission('ach-002:write')
  async addItem(
    @Param('id') id: string,
    @Body() dto: CreatePortfolioItemDto,
    @Req() req: AuthedRequest,
  ): Promise<PortfolioItemDto> {
    return this.portfolios.addItem(await this.resolveActor(req), id, dto);
  }

  @Patch('portfolio-items/:itemId')
  @RequirePermission('ach-002:write')
  async patchItem(
    @Param('itemId') itemId: string,
    @Body() dto: UpdatePortfolioItemDto,
    @Req() req: AuthedRequest,
  ): Promise<PortfolioItemDto> {
    return this.portfolios.patchItem(await this.resolveActor(req), itemId, dto);
  }

  @Delete('portfolio-items/:itemId')
  @RequirePermission('ach-002:write')
  @HttpCode(204)
  async removeItem(@Param('itemId') itemId: string, @Req() req: AuthedRequest): Promise<void> {
    return this.portfolios.removeItem(await this.resolveActor(req), itemId);
  }

  @Get('portfolio/items/sources')
  @RequirePermission('ach-002:read')
  @ApiOperation({
    summary:
      'List the calling student’s available source items (own classroom submissions, own published grades, own achievements) that can be added to a portfolio.',
  })
  async listSources(@Req() req: AuthedRequest): Promise<ItemSourceCandidateDto[]> {
    return this.portfolios.listSourceCandidates(await this.resolveActor(req));
  }

  // ── Shares ────────────────────────────────────────────────

  @Get('portfolio/:id/shares')
  @RequirePermission('ach-002:read')
  async listShares(@Param('id') id: string, @Req() req: AuthedRequest): Promise<ShareDto[]> {
    return this.shares.listForPortfolio(await this.resolveActor(req), id);
  }

  @Post('portfolio/:id/shares')
  @RequirePermission('ach-002:write')
  async createShare(
    @Param('id') id: string,
    @Body() dto: CreateShareDto,
    @Req() req: AuthedRequest,
  ): Promise<ShareDto> {
    return this.shares.create(await this.resolveActor(req), id, dto);
  }

  @Delete('portfolio-shares/:shareId')
  @RequirePermission('ach-002:write')
  @HttpCode(204)
  async revokeShare(@Param('shareId') shareId: string, @Req() req: AuthedRequest): Promise<void> {
    return this.shares.revoke(await this.resolveActor(req), shareId);
  }

  @Get('portfolio/share/:token')
  @Public()
  @ApiOperation({
    summary:
      'PUBLIC unauthenticated share-link view. Validates the token is ACTIVE + not expired, stamps viewed_at on first view, returns portfolio + featured items + achievements. Returns 410 Gone for expired/revoked tokens.',
  })
  async viewByToken(@Param('token') token: string): Promise<PublicPortfolioViewDto> {
    return this.shares.viewByToken(token);
  }

  // ── Achievements ──────────────────────────────────────────

  @Get('portfolio/achievements')
  @RequirePermission('ach-001:read')
  async listAchievements(
    @Query('studentId') studentId: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<AchievementDto[]> {
    return this.achievements.list(await this.resolveActor(req), studentId);
  }

  @Get('portfolio/students/:studentId/achievements')
  @RequirePermission('ach-001:read')
  async listForStudent(
    @Param('studentId') studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<AchievementDto[]> {
    return this.achievements.list(await this.resolveActor(req), studentId);
  }

  @Get('portfolio/achievements/:id')
  @RequirePermission('ach-001:read')
  async getAchievement(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AchievementDto> {
    return this.achievements.getById(await this.resolveActor(req), id);
  }

  @Post('portfolio/achievements')
  @RequirePermission('ach-001:write')
  async awardAchievement(
    @Body() dto: CreateAchievementDto,
    @Req() req: AuthedRequest,
  ): Promise<AchievementDto> {
    return this.achievements.create(await this.resolveActor(req), dto);
  }

  @Patch('portfolio/achievements/:id')
  @RequirePermission('ach-001:write')
  async patchAchievement(
    @Param('id') id: string,
    @Body() dto: UpdateAchievementDto,
    @Req() req: AuthedRequest,
  ): Promise<AchievementDto> {
    return this.achievements.patch(await this.resolveActor(req), id, dto);
  }

  @Get('portfolio/achievements/:id/shares')
  @RequirePermission('ach-001:read')
  async listAchievementShares(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AchievementShareDto[]> {
    return this.achievements.listShares(await this.resolveActor(req), id);
  }

  @Post('portfolio/achievements/:id/share')
  @RequirePermission('ach-001:read')
  @ApiOperation({
    summary:
      'Student shares own achievement to EMAIL/SOCIAL/PORTFOLIO. Service-layer check binds the caller to the owning student. Admins may share on behalf of a student.',
  })
  async shareAchievement(
    @Param('id') id: string,
    @Body() dto: CreateAchievementShareDto,
    @Req() req: AuthedRequest,
  ): Promise<AchievementShareDto> {
    return this.achievements.createShare(await this.resolveActor(req), id, dto);
  }
}
