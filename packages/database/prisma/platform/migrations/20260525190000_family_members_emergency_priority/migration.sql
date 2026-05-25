-- emergency_priority_order on platform_family_members.
--
-- The Family Settings → Emergency Contacts tab now reorders
-- guardians and manual contacts in one unified priority namespace
-- (so a closer-living grandparent can outrank a long-commuting
-- parent, or a manual neighbor entry can sit between two co-parents).
-- The combined sort needs a position on every row regardless of
-- which table it came from.
--
-- This column mirrors platform_family_emergency_contacts.priority_order
-- in shape (INTEGER NOT NULL DEFAULT 0). On a fresh family no reorder
-- has happened yet, so every row has 0 — the UI breaks the tie by
-- showing guardians (sorted by joined_at) before manual rows
-- (sorted by created_at). The first reorder fans positions out
-- across the unified [0..N-1] range.

ALTER TABLE platform.platform_family_members
  ADD COLUMN IF NOT EXISTS emergency_priority_order INTEGER NOT NULL DEFAULT 0;
