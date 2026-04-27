import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { AssignmentService } from './assignment.service';
import { AssignmentCategoryDto, UpsertCategoriesDto } from './dto/category.dto';

interface CategoryRow {
  id: string;
  class_id: string;
  name: string;
  weight: string;
  sort_order: number;
}

function rowToDto(row: CategoryRow): AssignmentCategoryDto {
  return {
    id: row.id,
    classId: row.class_id,
    name: row.name,
    weight: Number(row.weight),
    sortOrder: row.sort_order,
  };
}

@Injectable()
export class CategoryService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly assignments: AssignmentService,
  ) {}

  async list(classId: string, actor: ResolvedActor): Promise<AssignmentCategoryDto[]> {
    await this.assignments.assertCanReadClass(classId, actor);
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CategoryRow[]>(
        'SELECT id, class_id, name, weight, sort_order FROM cls_assignment_categories ' +
          'WHERE class_id = $1::uuid ORDER BY sort_order, name',
        classId,
      );
    });
    return rows.map(rowToDto);
  }

  /**
   * Replace the per-class category list atomically.
   *
   * Steps (single transaction):
   *   1. Validate weights sum to 100.00 (integer cents to avoid float drift).
   *   2. Validate names are unique within the body.
   *   3. UPSERT by (class_id, name): existing rows get weight/sort_order updated; new names insert.
   *   4. DELETE rows in the class whose name is not in the body. If a deleted category is
   *      still referenced by an assignment, the FK RESTRICT fires — surface a 409.
   *
   * Returns the new list (post-upsert).
   */
  async upsert(
    classId: string,
    body: UpsertCategoriesDto,
    actor: ResolvedActor,
  ): Promise<AssignmentCategoryDto[]> {
    await this.assignments.assertCanWriteClass(classId, actor);

    // Validate sum=100 in integer cents to dodge float drift.
    var totalCents = 0;
    var seen = new Set<string>();
    for (var i = 0; i < body.categories.length; i++) {
      var entry = body.categories[i]!;
      var nameKey = entry.name.trim().toLowerCase();
      if (seen.has(nameKey)) {
        throw new BadRequestException(
          'Duplicate category name "' + entry.name + '" in request body',
        );
      }
      seen.add(nameKey);
      totalCents += Math.round(entry.weight * 100);
    }
    if (totalCents !== 10000) {
      throw new BadRequestException(
        'Category weights must sum to 100; got ' + (totalCents / 100).toFixed(2),
      );
    }

    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        // Existence check on the class
        var classRows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM sis_classes WHERE id = $1::uuid',
          classId,
        );
        if (classRows.length === 0) {
          throw new NotFoundException('Class ' + classId + ' not found');
        }

        var existing = await tx.$queryRawUnsafe<Array<{ id: string; name: string }>>(
          'SELECT id, name FROM cls_assignment_categories WHERE class_id = $1::uuid',
          classId,
        );
        var existingByName = new Map<string, string>();
        for (var ei = 0; ei < existing.length; ei++) {
          existingByName.set(existing[ei]!.name, existing[ei]!.id);
        }

        var keepNames = new Set<string>();
        for (var bi = 0; bi < body.categories.length; bi++) {
          var c = body.categories[bi]!;
          keepNames.add(c.name);
          var existingId = existingByName.get(c.name);
          if (existingId !== undefined) {
            await tx.$executeRawUnsafe(
              'UPDATE cls_assignment_categories SET weight = $1::numeric, sort_order = $2, updated_at = now() ' +
                'WHERE id = $3::uuid',
              c.weight.toFixed(2),
              c.sortOrder ?? 0,
              existingId,
            );
          } else {
            var newId = generateId();
            await tx.$executeRawUnsafe(
              'INSERT INTO cls_assignment_categories (id, class_id, name, weight, sort_order) ' +
                'VALUES ($1::uuid, $2::uuid, $3, $4::numeric, $5)',
              newId,
              classId,
              c.name,
              c.weight.toFixed(2),
              c.sortOrder ?? 0,
            );
          }
        }

        // Delete categories not in the new list. FK RESTRICT will fire if still referenced.
        for (var oi = 0; oi < existing.length; oi++) {
          var ex = existing[oi]!;
          if (!keepNames.has(ex.name)) {
            await tx.$executeRawUnsafe(
              'DELETE FROM cls_assignment_categories WHERE id = $1::uuid',
              ex.id,
            );
          }
        }
      });
    } catch (e: any) {
      var msg = e && typeof e.message === 'string' ? e.message : '';
      if (
        msg.indexOf('foreign key') >= 0 ||
        msg.indexOf('cls_assignments_category_id_fkey') >= 0 ||
        msg.indexOf('violates foreign key constraint') >= 0
      ) {
        throw new ConflictException(
          'One or more categories are still referenced by an assignment — reassign those ' +
            'assignments to a different category before removing it from the list.',
        );
      }
      throw e;
    }

    return this.list(classId, actor);
  }
}
