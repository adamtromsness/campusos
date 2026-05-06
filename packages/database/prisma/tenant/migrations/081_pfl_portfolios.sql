/* ============================================================
 * Cycle 24 — Step 1: Portfolios + Items + Shares (Tenant)
 * ============================================================
 *
 * The M26 Portfolio module is the FOURTH student-input surface
 * in CampusOS after wellbeing check-ins (Cycle 11.1), library
 * reading logs and reviews (Cycle 12), and clubs service hours
 * (Cycle 17) — and the FIRST truly student-owned surface where
 * the student actor holds the write authority and curates their
 * own academic narrative.
 *
 * Step 1 lands 3 logical base tables:
 *
 *   - pfl_portfolios — one row per (student, school). 4-value
 *     visibility CHECK (PRIVATE, TEACHER, PARENT, PUBLIC) is
 *     monotonic — each tier unlocks a strictly larger reader
 *     set. UNIQUE(student_id, school_id) enforces the
 *     one-portfolio-per-student-per-school invariant.
 *
 *   - pfl_portfolio_items — items in a portfolio. 6-value
 *     item_type CHECK (SUBMISSION, GRADE, ACHIEVEMENT,
 *     REFLECTION, EXTERNAL_FILE, CERTIFICATE). source_ref_id is
 *     a polymorphic soft FK per ADR-001/020 — for SUBMISSION it
 *     points to cls_submissions, for GRADE to cls_grades, for
 *     ACHIEVEMENT to pfl_achievements. The Step 4 service
 *     resolves the source title at read time.
 *
 *   - pfl_portfolio_shares — share-link rows. share_token is a
 *     32-byte random hex string UNIQUE across the tenant. The
 *     Step 4 ShareService.viewByToken validates active + not
 *     expired, stamps viewed_at on first view, and returns the
 *     portfolio + featured items. status_chk keystone keeps
 *     status in lockstep with expires_at + viewed_at.
 *
 * 1 intra-tenant DB-enforced FK (CASCADE on items.portfolio_id
 * and shares.portfolio_id — children have no meaning without
 * their parent portfolio). 0 cross-schema FKs — every cross-
 * module ref is soft per ADR-001/020.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS pfl_portfolios (
  id                    UUID PRIMARY KEY,
  student_id            UUID NOT NULL,
  school_id             UUID NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  visibility            TEXT NOT NULL DEFAULT 'PRIVATE',
  share_link_enabled    BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pfl_portfolio_visibility_chk CHECK (
    visibility IN ('PRIVATE', 'TEACHER', 'PARENT', 'PUBLIC')
  ),
  CONSTRAINT pfl_portfolio_uq UNIQUE (student_id, school_id)
);

CREATE INDEX IF NOT EXISTS pfl_portfolio_school_idx
  ON pfl_portfolios (school_id);

COMMENT ON TABLE pfl_portfolios IS
  'Cycle 24 — student-owned portfolio. UNIQUE(student_id, school_id) so each student carries at most one portfolio per school. Visibility lattice (PRIVATE -> TEACHER -> PARENT -> PUBLIC) is monotonic. On student transfer or graduation the Step 4 service auto-resets visibility to PRIVATE.';

COMMENT ON COLUMN pfl_portfolios.student_id IS
  'Tenant-local soft reference to sis_students(id) per ADR-001/020 — the schema is intentionally schema-per-tenant, validated at the application layer. The owning student record lives in this tenant; cross-school portability flows through platform.platform_students at the SIS layer, not here.';

COMMENT ON COLUMN pfl_portfolios.visibility IS
  '4-value CHECK PRIVATE/TEACHER/PARENT/PUBLIC. PRIVATE: only the owning student. TEACHER: student + assigned teachers. PARENT: + linked guardians. PUBLIC: every authenticated user in the tenant.';

CREATE TABLE IF NOT EXISTS pfl_portfolio_items (
  id              UUID PRIMARY KEY,
  portfolio_id    UUID NOT NULL,
  item_type       TEXT NOT NULL,
  source_ref_id   UUID,
  title           TEXT NOT NULL,
  description     TEXT,
  s3_key          TEXT,
  is_featured     BOOLEAN NOT NULL DEFAULT false,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pfl_item_type_chk CHECK (
    item_type IN ('SUBMISSION', 'GRADE', 'ACHIEVEMENT', 'REFLECTION', 'EXTERNAL_FILE', 'CERTIFICATE')
  ),
  CONSTRAINT pfl_item_portfolio_fk FOREIGN KEY (portfolio_id)
    REFERENCES pfl_portfolios(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pfl_item_portfolio_idx
  ON pfl_portfolio_items (portfolio_id, is_featured, added_at DESC);

COMMENT ON TABLE pfl_portfolio_items IS
  'Cycle 24 — items in a student portfolio. CASCADE on portfolio delete since items have no meaning without the parent portfolio. source_ref_id is a polymorphic soft FK per ADR-001/020 — resolves to cls_submissions for SUBMISSION, cls_grades for GRADE, pfl_achievements for ACHIEVEMENT. Step 4 service enriches every row with the resolved source title at read time.';

COMMENT ON COLUMN pfl_portfolio_items.source_ref_id IS
  'Polymorphic soft FK per ADR-001/020. Interpreted via item_type. SUBMISSION -> cls_submissions(id). GRADE -> cls_grades(id). ACHIEVEMENT -> pfl_achievements(id). Application-layer resolution at read time. Null for REFLECTION and EXTERNAL_FILE and CERTIFICATE.';

COMMENT ON COLUMN pfl_portfolio_items.s3_key IS
  'S3 key for EXTERNAL_FILE and CERTIFICATE items. Step 4 service issues a signed URL for download. Null for SUBMISSION and GRADE and ACHIEVEMENT items.';

CREATE TABLE IF NOT EXISTS pfl_portfolio_shares (
  id                  UUID PRIMARY KEY,
  portfolio_id        UUID NOT NULL,
  share_token         TEXT NOT NULL UNIQUE,
  expires_at          TIMESTAMPTZ,
  recipient_email     TEXT,
  viewed_at           TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pfl_share_status_chk CHECK (
    status IN ('ACTIVE', 'EXPIRED', 'REVOKED')
  ),
  CONSTRAINT pfl_share_portfolio_fk FOREIGN KEY (portfolio_id)
    REFERENCES pfl_portfolios(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pfl_share_portfolio_idx
  ON pfl_portfolio_shares (portfolio_id, status);

CREATE INDEX IF NOT EXISTS pfl_share_expires_idx
  ON pfl_portfolio_shares (expires_at)
  WHERE expires_at IS NOT NULL;

COMMENT ON TABLE pfl_portfolio_shares IS
  'Cycle 24 — share-link rows. share_token is a 32-byte random hex string UNIQUE across the tenant. CASCADE on portfolio delete so revoking a portfolio also revokes its share links. The Step 4 ShareService.viewByToken returns 410 Gone for EXPIRED or REVOKED. Cleanup job on the partial INDEX(expires_at) flips ACTIVE rows past expires_at to EXPIRED.';

COMMENT ON COLUMN pfl_portfolio_shares.share_token IS
  'Cryptographically random 32-byte hex token. UNIQUE across the tenant. Generated at creation by the Step 4 ShareService via crypto.randomBytes(32).toString(hex).';

COMMENT ON COLUMN pfl_portfolio_shares.created_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. The student who created the share link.';
