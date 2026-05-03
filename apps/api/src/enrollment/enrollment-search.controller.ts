import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Public } from '../auth/public.decorator';
import {
  EnrollmentSearchResultDto,
  EnrollmentSearchService,
} from './enrollment-search.service';

class EnrollmentSearchQueryDto {
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  radiusMiles!: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  gradeLevel?: string;
}

@ApiTags('Enrollment Search')
@Controller('enrollment')
export class EnrollmentSearchController {
  constructor(private readonly search: EnrollmentSearchService) {}

  @Public()
  @Get('search')
  @ApiOperation({
    summary:
      'Public — find schools with open enrollment periods near a coordinate. Unauthenticated.',
  })
  async run(@Query() q: EnrollmentSearchQueryDto): Promise<EnrollmentSearchResultDto[]> {
    return this.search.search({
      lat: q.lat,
      lng: q.lng,
      radiusMiles: q.radiusMiles,
      gradeLevel: q.gradeLevel,
    });
  }
}
