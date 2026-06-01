-- Backfill platform_families.country = 'United States' wherever it is
-- NULL but a home address actually exists.
--
-- Why: the "Home address on file" completion check requires every
-- required field (street, city, state, ZIP, country). The Addresses
-- form displayed "United States" as a UI-only fallback that never
-- reached the DB unless the dropdown was toggled, so every existing
-- family with a saved address but a NULL country read as incomplete
-- without anyone realising the country was unset. This clears the item
-- on load with no dropdown interaction.
--
-- Scoped to rows that have a street + city: a family with no address at
-- all must NOT gain a country (that would falsely satisfy the criterion).
-- 'United States' is the canonical human-readable value the address
-- dropdown + formatAddressOneLine already expect (the column is the
-- display country, not a 2-letter code).
UPDATE platform.platform_families
   SET country = 'United States', updated_at = now()
 WHERE country IS NULL
   AND address_line1 IS NOT NULL AND btrim(address_line1) <> ''
   AND city IS NOT NULL AND btrim(city) <> '';
