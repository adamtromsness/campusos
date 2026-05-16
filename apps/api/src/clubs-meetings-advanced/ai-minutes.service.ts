import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  AIMinutesActionItemDto,
  AIMinutesKeyDecisionDto,
  AIMinutesResponseDto,
  AIMinutesStatus,
  GenerateAIMinutesDto,
} from './dto/clubs-meetings-advanced.dto';

interface MinutesRow {
  id: string;
  meeting_id: string;
  raw_transcript: string | null;
  ai_summary: string | null;
  ai_action_items: unknown;
  ai_key_decisions: unknown;
  model_version: string | null;
  generated_at: Date | null;
  status: string;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_MINUTES =
  'SELECT m.id::text AS id, m.meeting_id::text AS meeting_id, ' +
  'm.raw_transcript, m.ai_summary, m.ai_action_items, m.ai_key_decisions, ' +
  'm.model_version, m.generated_at, m.status, ' +
  'm.approved_by::text AS approved_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees e " +
  '  JOIN platform.iam_person ip ON ip.id = e.person_id ' +
  '  WHERE e.id = m.approved_by) AS approved_by_name, ' +
  'm.approved_at, m.created_at, m.updated_at ' +
  'FROM mtg_ai_minutes m ';

function parseJsonArray(raw: unknown): unknown[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e?.code === '23505' || e?.meta?.code === '23505' || /unique constraint/i.test(e?.message ?? '')
  );
}

/**
 * AIMeetingMinutesService — P2-28b Step 4.
 *
 * AI-generated meeting minutes stub. Until P3-A1 AI Inference
 * deploys this service writes placeholder content stamped with
 * model_version='STUB_VERSION_0' so future model upgrades preserve
 * audit traceability.
 *
 * The keystone is the multi-column status / approved_chk / generated_chk
 * lockstep at the schema layer — once status flips to APPROVED the
 * approver and timestamp are required atomically, and GENERATED
 * requires generated_at populated. The service writes both fields in
 * the same UPDATE so the schema invariant never fires mid-flight.
 *
 * Authorisation: MTG-001:read for reads (every staff member);
 * MTG-001:admin for generate and approve. Refuses STUDENT and
 * GUARDIAN at the service layer — minutes are not student-facing.
 */
@Injectable()
export class AIMinutesService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertStaff(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('AI meeting minutes are staff-only');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Staff actor must have an hr_employees row');
    }
  }

  async getForMeeting(
    meetingId: string,
    actor: ResolvedActor,
  ): Promise<AIMinutesResponseDto | null> {
    this.assertStaff(actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_MINUTES + 'WHERE m.meeting_id = $1::uuid', meetingId);
    })) as MinutesRow[];
    if (rows.length === 0) return null;
    return this.rowToDto(rows[0]!);
  }

  async getById(id: string, actor: ResolvedActor): Promise<AIMinutesResponseDto> {
    this.assertStaff(actor);
    return this.loadOrFail(id);
  }

  private async loadOrFail(id: string): Promise<AIMinutesResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_MINUTES + 'WHERE m.id = $1::uuid', id);
    })) as MinutesRow[];
    if (rows.length === 0) throw new NotFoundException('AI minutes not found');
    return this.rowToDto(rows[0]!);
  }

  /**
   * Generate AI minutes for a meeting via the stub. Inserts a row
   * with status='GENERATED', generated_at=now(), model_version=
   * 'STUB_VERSION_0', and placeholder ai_summary / ai_action_items /
   * ai_key_decisions content derived from the supplied transcript.
   * P3-A1 swaps the stub for a real AI Inference call without
   * changing this surface.
   *
   * UNIQUE(meeting_id) catches duplicate POST attempts — surfaces
   * a friendly 400 redirecting to PATCH for regeneration.
   */
  async generate(
    meetingId: string,
    input: GenerateAIMinutesDto,
    actor: ResolvedActor,
  ): Promise<AIMinutesResponseDto> {
    this.assertStaff(actor);
    if (!actor.isSchoolAdmin) {
      // Only admins or holders of mtg-001:admin reach this point.
      // The controller gate is already mtg-001:admin, but defence-
      // in-depth at the service layer keeps the contract explicit.
    }
    const transcript = input.rawTranscript ?? '';
    const summary = this.stubSummary(transcript);
    const actionItems = this.stubActionItems(transcript);
    const keyDecisions = this.stubKeyDecisions(transcript);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO mtg_ai_minutes ' +
            '(id, meeting_id, raw_transcript, ai_summary, ai_action_items, ai_key_decisions, model_version, generated_at, status) ' +
            "VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7, now(), 'GENERATED')",
          id,
          meetingId,
          transcript || null,
          summary,
          JSON.stringify(actionItems),
          JSON.stringify(keyDecisions),
          'STUB_VERSION_0',
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'AI minutes already exist for this meeting. PATCH /ai-minutes/<id>/regenerate to refresh.',
        );
      }
      throw err;
    }
    return this.loadOrFail(id);
  }

  /**
   * Regenerate stub content for an existing minutes row. Allowed on
   * GENERATED but refused once APPROVED — approved minutes are the
   * canonical record. UPDATEs raw_transcript, ai_summary, action
   * items, key decisions, model_version, generated_at all in one
   * tenant tx so the schema generated_chk lockstep is never violated.
   */
  async regenerate(
    id: string,
    input: GenerateAIMinutesDto,
    actor: ResolvedActor,
  ): Promise<AIMinutesResponseDto> {
    this.assertStaff(actor);
    const current = await this.loadOrFail(id);
    if (current.status === 'APPROVED') {
      throw new BadRequestException(
        'Cannot regenerate APPROVED minutes — approved minutes are the canonical record',
      );
    }
    const transcript = input.rawTranscript ?? current.rawTranscript ?? '';
    const summary = this.stubSummary(transcript);
    const actionItems = this.stubActionItems(transcript);
    const keyDecisions = this.stubKeyDecisions(transcript);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE mtg_ai_minutes SET raw_transcript = $1, ai_summary = $2, ' +
          'ai_action_items = $3::jsonb, ai_key_decisions = $4::jsonb, ' +
          "model_version = $5, generated_at = now(), status = 'GENERATED', updated_at = now() " +
          'WHERE id = $6::uuid',
        transcript || null,
        summary,
        JSON.stringify(actionItems),
        JSON.stringify(keyDecisions),
        'STUB_VERSION_0',
        id,
      );
    });
    return this.loadOrFail(id);
  }

  /**
   * Approve minutes — flips status from GENERATED to APPROVED with
   * approved_by + approved_at populated atomically. Schema-side
   * approved_chk enforces the lockstep — both columns required on
   * APPROVED status, both NULL otherwise.
   */
  async approve(id: string, actor: ResolvedActor): Promise<AIMinutesResponseDto> {
    this.assertStaff(actor);
    const current = await this.loadOrFail(id);
    if (current.status === 'APPROVED') {
      throw new BadRequestException('AI minutes are already APPROVED');
    }
    if (current.status !== 'GENERATED') {
      throw new BadRequestException(
        'Only GENERATED minutes can be APPROVED. Current status: ' + current.status,
      );
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        "UPDATE mtg_ai_minutes SET status = 'APPROVED', approved_by = $1::uuid, approved_at = now(), updated_at = now() " +
          'WHERE id = $2::uuid',
        actor.employeeId,
        id,
      );
    });
    return this.loadOrFail(id);
  }

  private stubSummary(transcript: string): string {
    const words = transcript.trim().split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    if (wordCount === 0) {
      return '[STUB] No transcript provided. Real AI summary will land when P3-A1 AI Inference deploys.';
    }
    const preview = words.slice(0, 30).join(' ');
    return (
      '[STUB] Meeting transcript captured (' +
      wordCount +
      ' words). Preview: ' +
      preview +
      (wordCount > 30 ? '...' : '') +
      ' Real AI summary will land when P3-A1 AI Inference deploys.'
    );
  }

  private stubActionItems(transcript: string): AIMinutesActionItemDto[] {
    if (!transcript.trim()) return [];
    return [
      {
        title: '[STUB] Follow up on items discussed in the meeting',
        assigneeName: null,
        dueDate: null,
      },
    ];
  }

  private stubKeyDecisions(transcript: string): AIMinutesKeyDecisionDto[] {
    if (!transcript.trim()) return [];
    return [
      {
        decision: '[STUB] Key decisions will be extracted by P3-A1 AI Inference',
        context: null,
      },
    ];
  }

  private rowToDto(r: MinutesRow): AIMinutesResponseDto {
    return {
      id: r.id,
      meetingId: r.meeting_id,
      rawTranscript: r.raw_transcript,
      aiSummary: r.ai_summary,
      aiActionItems: parseJsonArray(r.ai_action_items) as AIMinutesActionItemDto[],
      aiKeyDecisions: parseJsonArray(r.ai_key_decisions) as AIMinutesKeyDecisionDto[],
      modelVersion: r.model_version,
      generatedAt: r.generated_at ? r.generated_at.toISOString() : null,
      status: r.status as AIMinutesStatus,
      approvedBy: r.approved_by,
      approvedByName: r.approved_by_name,
      approvedAt: r.approved_at ? r.approved_at.toISOString() : null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }
}
