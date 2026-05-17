import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { AIOptOutService } from './ai-opt-out.service';
import { CreateOptOutDto, OptOutResponseDto } from './dto/ai-tutoring.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — AI Opt-Out')
@ApiBearerAuth()
@Controller('classroom')
export class AIOptOutController {
  constructor(
    private readonly optOuts: AIOptOutService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('ai-tutoring/opt-out')
  @RequirePermission('tch-007:read')
  @ApiOperation({
    summary:
      'Opt a student out of AI tutoring. Guardians may opt out their own children only; students may opt themselves out; admins may opt out anyone in the school. Service-layer check enforces these.',
  })
  async create(
    @Body() body: CreateOptOutDto,
    @Req() req: AuthedRequest,
  ): Promise<OptOutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.optOuts.create(body, actor);
  }

  @Get('ai-tutoring/opt-out/:studentId')
  @RequirePermission('tch-007:read')
  @ApiOperation({
    summary: 'Check whether a student is opted out. Returns the opt-out record or 404.',
  })
  async getOne(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<OptOutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.optOuts.getByStudent(studentId, actor);
  }

  @Delete('ai-tutoring/opt-out/:studentId')
  @HttpCode(204)
  @RequirePermission('tch-007:read')
  @ApiOperation({
    summary:
      'Opt a student back in. Same authorisation as opt-out — guardian / student-self / admin only.',
  })
  async delete(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.optOuts.delete(studentId, actor);
  }
}
