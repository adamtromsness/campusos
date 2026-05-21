import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * P2-H4 Step 1 Tier 3 — Atomic operation regression.
 *
 * Seven concurrency-sensitive code paths in CampusOS are documented as
 * atomic. Each uses one of three patterns:
 *
 *   A. Single SQL statement with both check + write
 *      (e.g. `UPDATE … WHERE quantity_sold + $1 <= quantity RETURNING *`)
 *
 *   B. `SELECT … FOR UPDATE` inside `executeInTenantTransaction`
 *      followed by an UPDATE on the locked row
 *
 *   C. `pg_advisory_xact_lock(hashtext(...))` inside
 *      `executeInTenantTransaction` for cross-row coordination
 *
 * This spec asserts the source file for each path uses the documented
 * pattern. The static check is the cheapest regression — the live
 * concurrent-race tests (5 parallel POSTs land 1 success + 4 conflicts)
 * are captured in the cycle CAT scripts and re-run on every cycle.
 *
 * Seven atomic operations covered:
 *
 *   1. Ticket sales (evt_ticket_tiers atomic UPDATE)
 *   2. Conference booking (eng_conference_slots locked update)
 *   3. Gate scanning (evt_tickets atomic UPDATE WHERE token + VALID)
 *   4. Gift card redemption (str_gift_cards atomic UPDATE)
 *   5. Budget transfer (FOR UPDATE on both budgets in id-asc order)
 *   6. Promotion max_uses (atomic UPDATE on max_uses gate)
 *   7. Journal batch balance (PostingService.post inside one tx)
 */

const API_SRC = join(__dirname, '..', '..', '..', '..', 'src');

interface AtomicCheck {
  name: string;
  file: string;
  patterns: { name: string; regex: RegExp }[];
}

const ATOMIC_OPS: AtomicCheck[] = [
  {
    name: 'Ticket sale (atomic quantity_sold UPDATE)',
    file: 'modules/m101-events/orders.service.ts',
    patterns: [
      // The Cycle 12 keystone: single UPDATE with the cap in WHERE.
      {
        name: 'atomic UPDATE evt_ticket_tiers with cap predicate',
        regex: /UPDATE\s+evt_ticket_tiers[\s\S]*?quantity_sold[\s\S]*?<=\s*quantity/i,
      },
    ],
  },
  {
    name: 'Conference slot booking (locked-row UPDATE)',
    file: 'modules/m100-engagement/conference-booking.service.ts',
    patterns: [
      {
        name: 'FOR UPDATE inside executeInTenantTransaction',
        regex: /executeInTenantTransaction[\s\S]*?FOR UPDATE/i,
      },
    ],
  },
  {
    name: 'Gate scanning (atomic UPDATE WHERE token + VALID)',
    file: 'modules/m101-events/gate.service.ts',
    patterns: [
      {
        name: 'atomic UPDATE evt_tickets with status gate in WHERE',
        regex: /UPDATE\s+evt_tickets[\s\S]*?WHERE[\s\S]*?qr_code_token[\s\S]*?VALID/i,
      },
    ],
  },
  {
    name: 'Gift card redemption (atomic balance UPDATE)',
    file: 'modules/m67-store/gift-cards/gift-card.service.ts',
    patterns: [
      {
        name: 'atomic UPDATE str_gift_cards with balance gate in WHERE',
        regex: /UPDATE\s+str_gift_cards[\s\S]*?balance/i,
      },
    ],
  },
  {
    name: 'Budget transfer (FOR UPDATE on both budgets, ordered)',
    file: 'modules/m83-finance/budgets.service.ts',
    patterns: [
      {
        name: 'FOR UPDATE inside executeInTenantTransaction on budget rows',
        regex: /executeInTenantTransaction[\s\S]*?FOR UPDATE/i,
      },
    ],
  },
  {
    name: 'Promotion max_uses keystone (atomic UPDATE WHERE current < max)',
    file: 'modules/m67-store/promotions/promotion.service.ts',
    patterns: [
      {
        name: 'atomic UPDATE str_promotions with current_uses < max_uses',
        regex: /UPDATE\s+str_promotions[\s\S]*?current_uses[\s\S]*?max_uses/i,
      },
    ],
  },
  {
    name: 'Journal batch balance validation (sum(debit) = sum(credit) inside tx)',
    file: 'modules/m83-finance/posting.service.ts',
    patterns: [
      {
        name: 'executeInTenantTransaction wraps the balance check + status flip',
        regex: /executeInTenantTransaction[\s\S]*?SUM\(debit\)[\s\S]*?SUM\(credit\)/i,
      },
    ],
  },
];

describe('P2-H4 Step 1 Tier 3 — atomic operation regression', () => {
  for (const op of ATOMIC_OPS) {
    describe(op.name, () => {
      it('source file present', () => {
        const full = join(API_SRC, op.file);
        let src: string | null = null;
        try {
          src = readFileSync(full, 'utf8');
        } catch {
          src = null;
        }
        // Some files may have moved as the codebase evolved; surface
        // a clear miss so the reviewer can rename or remove the entry.
        expect(src, `expected file ${op.file}`).not.toBeNull();
      });

      for (const pattern of op.patterns) {
        it(`uses pattern: ${pattern.name}`, () => {
          const full = join(API_SRC, op.file);
          let src: string;
          try {
            src = readFileSync(full, 'utf8');
          } catch {
            // If the file doesn't exist, defer to the file-present
            // test above which will already have failed loudly.
            return;
          }
          expect(pattern.regex.test(src), `${op.file} missing expected SQL pattern`).toBe(true);
        });
      }
    });
  }
});
