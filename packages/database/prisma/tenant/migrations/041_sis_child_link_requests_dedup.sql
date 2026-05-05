/* 041_sis_child_link_requests_dedup.sql
 * REVIEW-PHASE2-POLISH MAJOR 3 plus 4 — duplicate-pending-request guards.
 *
 * Phase 2 Parent Polish landed sis_child_link_requests in migration 024 with
 * an app-layer pre-check on submitLinkExisting (SELECT then INSERT). That
 * race-loses under concurrent submits — two parallel double-clicks can both
 * pass the pre-check and both INSERT a PENDING row for the same target
 * student. submitAddNew shipped without any duplicate guard at all.
 *
 * Fix per REVIEW-PHASE2-POLISH MAJOR 3 plus 4 — two partial UNIQUE indexes
 * scoped to PENDING rows so that approval or rejection releases the slot.
 *
 *   LINK_EXISTING — UNIQUE on (requesting_guardian_id, existing_student_id)
 *                   WHERE status equals PENDING AND request_type equals LINK_EXISTING.
 *                   The natural duplicate key is the (guardian, target student) pair.
 *
 *   ADD_NEW       — UNIQUE on (requesting_guardian_id, LOWER(first_name),
 *                   LOWER(last_name), date_of_birth)
 *                   WHERE status equals PENDING AND request_type equals ADD_NEW.
 *                   Case-insensitive on names because parents retype them
 *                   inconsistently. DOB is the disambiguator on otherwise
 *                   identical name pairs.
 *
 * The ChildLinkRequestService update wraps both submit methods in a tenant
 * transaction and catches SQLSTATE 23505 (Postgres P2010 from Prisma) to
 * convert the schema-side rejection into a friendly 409 ConflictException.
 *
 * Schema-side dedup is the belt-and-braces. The service-layer pre-check
 * stays as the friendly-error happy path. Both indexes are PARTIAL so
 * once a request is approved or rejected, the (guardian, child) slot
 * frees up for a re-submit.
 *
 * Migration discipline. Block-comment header with no semicolons inside
 * any string literal or comment per the splitter trap from Cycles 4
 * through 11.1.
 */

CREATE UNIQUE INDEX IF NOT EXISTS sis_child_link_requests_link_existing_pending_uq
  ON sis_child_link_requests (requesting_guardian_id, existing_student_id)
  WHERE status = 'PENDING' AND request_type = 'LINK_EXISTING';

CREATE UNIQUE INDEX IF NOT EXISTS sis_child_link_requests_add_new_pending_uq
  ON sis_child_link_requests (
    requesting_guardian_id,
    LOWER(new_child_first_name),
    LOWER(new_child_last_name),
    new_child_date_of_birth
  )
  WHERE status = 'PENDING' AND request_type = 'ADD_NEW';

COMMENT ON INDEX sis_child_link_requests_link_existing_pending_uq IS
  'REVIEW-PHASE2-POLISH MAJOR 3 — partial UNIQUE caps PENDING LINK_EXISTING rows at one per (guardian, target student) pair. Approval or rejection releases the slot.';

COMMENT ON INDEX sis_child_link_requests_add_new_pending_uq IS
  'REVIEW-PHASE2-POLISH MAJOR 4 — partial UNIQUE caps PENDING ADD_NEW rows at one per (guardian, LOWER first name, LOWER last name, DOB) tuple. Case-insensitive on names so parents retyping inconsistently still hit the dedup.';
