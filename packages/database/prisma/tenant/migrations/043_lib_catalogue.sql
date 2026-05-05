/* 043_lib_catalogue.sql
 * Cycle 12 Step 1 — M24 Library catalogue infrastructure (locations,
 * catalogue items with full-text search, physical copies with barcode
 * tracking).
 *
 * Three new tenant base tables for the Library module. The Step 2
 * migration adds circulation (policies, checkouts, holds, fines). The
 * Step 3 migration adds reading programmes, reading lists, and book
 * reviews on top.
 *
 *   lib_locations         Named library locations. Drives the where is
 *                         this copy tracking on lib_catalogue_copies.
 *                         location_type is a 6-value enum CHECK SHELF,
 *                         DISPLAY, BOOK_DROP, PROCESSING, REPAIR,
 *                         STORAGE. UNIQUE(school_id, name) so two
 *                         locations cannot share a name in the same
 *                         school. is_active flag for soft deactivation
 *                         when a shelf is retired without losing the
 *                         historical link from copies that lived there.
 *
 *   lib_catalogue_items   Bibliographic record. One row per title.
 *                         Composite index on (school_id, title) for
 *                         the alphabetical browse hot path. INDEX on
 *                         isbn for direct ISBN lookup. The keystone
 *                         GIN index on to_tsvector('english',
 *                         title || space || COALESCE(author, empty))
 *                         backs the public catalogue search bar in
 *                         Step 5 with ts_rank ordering and
 *                         plainto_tsquery scoring. cover_image_url is
 *                         nullable and carries an S3 or external URL.
 *                         dewey_decimal is a free-form TEXT because
 *                         schools mix Dewey numbers with custom shelf
 *                         labels.
 *
 *   lib_catalogue_copies  Physical copy. One row per book on the
 *                         shelf. barcode is UNIQUE across the tenant
 *                         (the scannable identifier on the spine).
 *                         condition is a 5-value enum CHECK NEW, GOOD,
 *                         FAIR, POOR, LOST. location_status is a
 *                         7-value enum CHECK ON_SHELF, IN_BOOK_DROP,
 *                         IN_PROCESSING, CHECKED_OUT, ON_HOLD_SHELF,
 *                         IN_REPAIR, LOST. is_available flag mirrors
 *                         the available-vs-not state and flips on
 *                         every checkout / return for fast availability
 *                         filters without joining lib_checkouts.
 *                         INDEX on (catalogue_item_id, is_available)
 *                         backs the per-item available-copies count
 *                         the Step 5 service surfaces inline.
 *                         replacement_value is a NUMERIC(8,2) used by
 *                         the Step 6 FineService when a copy is marked
 *                         LOST.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020:
 *   lib_locations.school_id        -> platform.schools(id)
 *   lib_catalogue_items.school_id  -> platform.schools(id)
 *
 * DB-enforced intra-tenant FKs (2 logical):
 *   lib_catalogue_copies.catalogue_item_id -> lib_catalogue_items(id) CASCADE
 *     A copy is meaningless without its catalogue item. CASCADE on
 *     parent item delete drops every copy. Deactivation by setting
 *     is_available=false is the supported soft-delete path.
 *   lib_catalogue_copies.location_id       -> lib_locations(id) SET NULL
 *     A copy survives the retirement of a shelf with the location_id
 *     cleared. The librarian then assigns the copy to a new location.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 11.1. The
 * splitter cuts on every semicolon regardless of quoting context
 * including inside block comments and inside default expressions and
 * inside index expressions.
 */

CREATE TABLE IF NOT EXISTS lib_locations (
  id              UUID         PRIMARY KEY,
  school_id       UUID         NOT NULL,
  name            TEXT         NOT NULL,
  location_type   TEXT         NOT NULL,
  sort_order      INT          NOT NULL DEFAULT 0,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_locations_type_chk
    CHECK (location_type IN ('SHELF', 'DISPLAY', 'BOOK_DROP', 'PROCESSING', 'REPAIR', 'STORAGE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS lib_locations_school_name_uq
  ON lib_locations (school_id, name);

CREATE INDEX IF NOT EXISTS lib_locations_school_active_idx
  ON lib_locations (school_id, is_active);

COMMENT ON TABLE lib_locations IS
  'Named library locations driving the where-is-this-copy tracking on lib_catalogue_copies. The Step 5 LocationService is the canonical writer. Locations are deactivated rather than hard-deleted once they have been used as a copy location — the schema-side SET NULL on lib_catalogue_copies.location_id ensures a hard-delete leaves copies addressable while their location is reassigned.';

COMMENT ON COLUMN lib_locations.location_type IS
  'SHELF for the canonical Fiction or Non-Fiction shelves. DISPLAY for new arrivals or themed displays. BOOK_DROP for the after-hours return slot. PROCESSING for the workflow step between donation and shelving. REPAIR for the in-house repair queue. STORAGE for archived or seasonal stock.';

CREATE TABLE IF NOT EXISTS lib_catalogue_items (
  id                UUID         PRIMARY KEY,
  school_id         UUID         NOT NULL,
  title             TEXT         NOT NULL,
  author            TEXT,
  isbn              TEXT,
  publisher         TEXT,
  publish_year      INT,
  category          TEXT,
  dewey_decimal     TEXT,
  description       TEXT,
  cover_image_url   TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lib_catalogue_items_school_title_idx
  ON lib_catalogue_items (school_id, title);

CREATE INDEX IF NOT EXISTS lib_catalogue_items_isbn_idx
  ON lib_catalogue_items (isbn);

CREATE INDEX IF NOT EXISTS lib_catalogue_items_search_idx
  ON lib_catalogue_items
  USING GIN (to_tsvector('english', title || ' ' || COALESCE(author, '')));

COMMENT ON TABLE lib_catalogue_items IS
  'Bibliographic record — one row per title. The Step 5 CatalogueItemService is the canonical writer. The GIN full-text index backs the public catalogue search bar with ts_rank scoring on the concatenation of title and author. ISBN is indexed separately for direct ISBN lookup from the librarian add-copy flow. cover_image_url is nullable and carries either an S3 key or an external URL. dewey_decimal is a free-form TEXT because schools mix Dewey decimals with custom local shelf labels.';

COMMENT ON COLUMN lib_catalogue_items.title IS
  'The primary search target. Fed into to_tsvector with the author column for the GIN index. Required and never null because the search bar would have nothing to rank.';

COMMENT ON COLUMN lib_catalogue_items.author IS
  'Optional secondary search target. Concatenated with title in the GIN index expression with COALESCE to empty string so a missing author cannot null out the tsvector.';

COMMENT ON COLUMN lib_catalogue_items.dewey_decimal IS
  'Free-form TEXT. Some schools use the Dewey Decimal Classification (e.g. 813.54). Some schools use custom Genre + Author labels (e.g. FIC-LOW). The schema does not enforce a format because the librarian decides per-school.';

CREATE TABLE IF NOT EXISTS lib_catalogue_copies (
  id                  UUID         PRIMARY KEY,
  catalogue_item_id   UUID         NOT NULL REFERENCES lib_catalogue_items(id) ON DELETE CASCADE,
  location_id         UUID         REFERENCES lib_locations(id) ON DELETE SET NULL,
  barcode             TEXT         NOT NULL,
  condition           TEXT         NOT NULL DEFAULT 'NEW',
  is_available        BOOLEAN      NOT NULL DEFAULT true,
  replacement_value   NUMERIC(8,2),
  location_status     TEXT         NOT NULL DEFAULT 'ON_SHELF',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_copies_condition_chk
    CHECK (condition IN ('NEW', 'GOOD', 'FAIR', 'POOR', 'LOST')),
  CONSTRAINT lib_copies_status_chk
    CHECK (location_status IN ('ON_SHELF', 'IN_BOOK_DROP', 'IN_PROCESSING', 'CHECKED_OUT', 'ON_HOLD_SHELF', 'IN_REPAIR', 'LOST')),
  CONSTRAINT lib_copies_replacement_chk
    CHECK (replacement_value IS NULL OR replacement_value >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS lib_copies_barcode_uq
  ON lib_catalogue_copies (barcode);

CREATE INDEX IF NOT EXISTS lib_copies_item_available_idx
  ON lib_catalogue_copies (catalogue_item_id, is_available);

CREATE INDEX IF NOT EXISTS lib_copies_location_idx
  ON lib_catalogue_copies (location_id)
  WHERE location_id IS NOT NULL;

COMMENT ON TABLE lib_catalogue_copies IS
  'Physical copy — one row per book on the shelf. The Step 5 CopyService is the canonical writer for create / patch and the Step 6 CheckoutService is the canonical writer for the is_available + location_status state machine on every checkout / return. barcode is UNIQUE across the tenant — the scannable identifier on the spine that the circulation desk reads to resolve copy + item + checkout state in one call. CASCADE on parent item delete because a copy without its bibliographic record is meaningless. SET NULL on parent location delete because a copy survives a shelf retirement (the librarian then reassigns it).';

COMMENT ON COLUMN lib_catalogue_copies.barcode IS
  'The scannable identifier on the physical book. UNIQUE across the tenant. The Step 5 CopyService exposes GET /library/copies/barcode/:barcode as the keystone barcode-to-copy lookup the circulation desk hits on every scan.';

COMMENT ON COLUMN lib_catalogue_copies.is_available IS
  'Mirrors the available-vs-not state of the copy. Flips false on checkout, true on return. Denormalised so the Step 5 catalogue list can compute available-copies count per item without joining lib_checkouts. The Step 6 CheckoutService is the canonical writer of the boolean inside the same tx as the lib_checkouts row insert / update.';

COMMENT ON COLUMN lib_catalogue_copies.location_status IS
  'ON_SHELF is the canonical resting state. IN_BOOK_DROP for the after-hours return slot before the librarian processes it. IN_PROCESSING for newly-acquired copies awaiting cataloguing. CHECKED_OUT mirrors is_available=false during an active checkout. ON_HOLD_SHELF when a returned copy has been reassigned to fulfil a PENDING hold per the Step 6 HoldService logic. IN_REPAIR for a damaged copy in the in-house queue. LOST for a copy a patron failed to return.';

COMMENT ON COLUMN lib_catalogue_copies.replacement_value IS
  'NUMERIC(8,2). Used by the Step 6 FineService when a copy is marked LOST. Nullable because the librarian may not have a price recorded for older or donated copies.';
