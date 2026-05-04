import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/require-permission.decorator';
import { SlaService } from './sla.service';
import { SlaPolicyResponseDto, UpsertSlaPolicyDto } from './dto/ticket.dto';

@ApiTags('Ticket SLA')
@ApiBearerAuth()
@Controller('ticket-sla')
export class SlaController {
  constructor(private readonly sla: SlaService) {}

  @Get()
  @RequirePermission('it-001:read')
  @ApiOperation({ summary: 'Full SLA matrix for the school. Sorted by category then priority.' })
  list(): Promise<SlaPolicyResponseDto[]> {
    return this.sla.list();
  }

  @Post()
  @RequirePermission('it-001:admin')
  @ApiOperation({
    summary:
      'Upsert an SLA policy by (category, priority). Existing rows are updated in place; new rows land via INSERT.',
  })
  upsert(@Body() body: UpsertSlaPolicyDto): Promise<SlaPolicyResponseDto> {
    return this.sla.upsert(body);
  }
}
