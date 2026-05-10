/* 130_ath_equipment_conferences.sql
 *
 * Phase 2 Cycle 8 (P2-8) sub-cycle a — Athletics Advanced.
 *
 * Plan reference — docs/campusos-p2c8-athletics-advanced.html Step 1.
 *
 * Plan migration number is 115 but slot 115 is taken (hr_interview_panel_members_role_chk).
 * Used 130 per the established Cycle 4 onwards convention of using the next
 * available slot when the planned number is occupied.
 *
 * 9 new tenant base tables for the M66 .1 athletics equipment plus
 * conferences plus media surface. No external service dependencies.
 * Independently shippable. The companion P2-8b sub-cycle adds the digital
 * layer (streaming plus officials marketplace plus advanced stats plus
 * recruiting profiles) in a follow-up migration.
 *
 *   ath_equipment                  — Inventory item per (school, programme).
 *                                    item_type 6-value CHECK UNIFORM,
 *                                    PROTECTIVE_GEAR, TRAINING_EQUIPMENT,
 *                                    GAME_EQUIPMENT, MEDICAL_EQUIPMENT, OTHER.
 *                                    condition 5-value CHECK EXCELLENT, GOOD,
 *                                    FAIR, POOR, RETIRED. quantity counts the
 *                                    school size of this item type. unit_cost
 *                                    drives the replacement charge default.
 *                                    INDEX(school_id, programme_id) for the
 *                                    equipment manager list view.
 *
 *   ath_equipment_checkouts        — Per-(equipment, person) checkout. The
 *                                    EquipmentService writes one row per
 *                                    issued item with item_identifier
 *                                    (jersey number plus barcode plus
 *                                    serial). condition_at_return is a
 *                                    nullable 3-value CHECK GOOD, DAMAGED,
 *                                    LOST stamped at return. damage_notes
 *                                    plus replacement_charge populate when
 *                                    condition_at_return is DAMAGED or LOST.
 *                                    Partial INDEX (assigned_to_person_id,
 *                                    returned_at) WHERE returned_at IS NULL
 *                                    drives the active checkouts hot path.
 *
 *   ath_safety_equipment           — Per-(roster_member, equipment_type)
 *                                    safety compliance row. equipment_type
 *                                    6-value CHECK HELMET, PADS, MOUTHGUARD,
 *                                    SHIN_GUARDS, GOGGLES, OTHER.
 *                                    UNIQUE(roster_member_id, equipment_type)
 *                                    so each member has exactly one row per
 *                                    safety equipment type. issued plus
 *                                    meets_safety_standard plus
 *                                    certification_date plus
 *                                    certification_expiry plus recall_status
 *                                    drive the per-roster compliance
 *                                    checklist UI. Safety compliance must
 *                                    be verified before game participation.
 *
 *   ath_conferences                — Platform-level conference catalogue.
 *                                    No school_id — conferences span schools.
 *                                    UNIQUE(name, sport) so one conference
 *                                    per (name, sport) tuple. region plus
 *                                    governing_body plus is_active drive
 *                                    the conference list filter chips.
 *
 *   ath_conference_memberships     — Per-(conference, school, programme)
 *                                    membership row. UNIQUE on the triple
 *                                    so each programme joins a conference
 *                                    at most once. level is the division
 *                                    name within the conference (D1, D2,
 *                                    Premier, etc) — free-form TEXT.
 *
 *   ath_conference_schedules       — Per-(conference, season) cross-school
 *                                    game slot. home_school_id plus
 *                                    away_school_id plus scheduled_date
 *                                    plus optional scheduled_time. The
 *                                    linked_game_id is populated when the
 *                                    actual ath_games row is created from
 *                                    the schedule entry. INDEX(conference_id,
 *                                    scheduled_date) drives the season
 *                                    schedule grid view.
 *
 *   ath_team_photos                — Per-(roster) team photo or action shot
 *                                    or individual headshot. photo_type
 *                                    3-value CHECK TEAM_PHOTO, ACTION_SHOT,
 *                                    INDIVIDUAL. s3_key is the signed-URL
 *                                    pointer matching the hr_employee_documents
 *                                    convention from Cycle 4.
 *
 *   ath_media_assets               — Per-(school, programme) media asset
 *                                    catalogue. asset_type 4-value CHECK
 *                                    PHOTO, VIDEO, DOCUMENT, LOGO. Optional
 *                                    season_id link. The Step 2 TeamMediaService
 *                                    writes one row per uploaded asset.
 *                                    INDEX(school_id, programme_id, asset_type)
 *                                    drives the media gallery filter view.
 *
 *   ath_equipment_maintenance      — Per-equipment maintenance log entry.
 *                                    maintenance_type 4-value CHECK CLEANING,
 *                                    REPAIR, INSPECTION, RECONDITIONING.
 *                                    cost is the maintenance expense and
 *                                    next_maintenance_date drives the
 *                                    upcoming-maintenance dashboard.
 *
 * 9 new intra-tenant FKs (CASCADE x 6 + NO ACTION x 3). 0 cross-schema
 * FKs. All cross-module refs to platform.iam_person and to schools follow
 * the soft FK convention per ADR-001/020 + ADR-055.
 *
 * Splitter convention — no semicolons inside string literals or block
 * comment headers. Every comment uses periods, em-dashes, "and", or
 * "plus" connectives.
 */

CREATE TABLE IF NOT EXISTS ath_equipment (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    programme_id UUID NOT NULL REFERENCES ath_programmes(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL,
    item_name TEXT NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    condition TEXT NOT NULL DEFAULT 'GOOD',
    purchase_date DATE,
    unit_cost NUMERIC(8,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_equipment_item_type_chk
      CHECK (item_type IN ('UNIFORM','PROTECTIVE_GEAR','TRAINING_EQUIPMENT','GAME_EQUIPMENT','MEDICAL_EQUIPMENT','OTHER')),
    CONSTRAINT ath_equipment_condition_chk
      CHECK (condition IN ('EXCELLENT','GOOD','FAIR','POOR','RETIRED')),
    CONSTRAINT ath_equipment_quantity_chk CHECK (quantity >= 0),
    CONSTRAINT ath_equipment_unit_cost_chk
      CHECK (unit_cost IS NULL OR unit_cost >= 0),
    CONSTRAINT ath_equipment_item_name_chk
      CHECK (length(trim(item_name)) > 0)
);

CREATE INDEX IF NOT EXISTS ath_equipment_school_programme_idx
  ON ath_equipment(school_id, programme_id);

CREATE INDEX IF NOT EXISTS ath_equipment_programme_type_idx
  ON ath_equipment(programme_id, item_type);

COMMENT ON TABLE ath_equipment IS
  'Inventory item per (school, programme). The Step 2 EquipmentService is the canonical writer. item_type 6-value CHECK groups items for the equipment manager filter chips. condition 5-value CHECK drives the colour pill on the inventory table. quantity tracks the school size of the item type. unit_cost is the replacement-charge default the EquipmentService uses when condition_at_return is DAMAGED or LOST.';

COMMENT ON COLUMN ath_equipment.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020. Denormalised so the equipment list view can scope by school.';

COMMENT ON COLUMN ath_equipment.programme_id IS
  'DB-enforced FK to ath_programmes(id) ON DELETE CASCADE. Equipment is meaningless without its parent programme. The Step 2 service refuses to surface equipment for inactive programmes through the inventory list.';

CREATE TABLE IF NOT EXISTS ath_equipment_checkouts (
    id UUID PRIMARY KEY,
    equipment_id UUID NOT NULL REFERENCES ath_equipment(id) ON DELETE CASCADE,
    assigned_to_person_id UUID NOT NULL,
    item_identifier TEXT,
    checked_out_at DATE NOT NULL DEFAULT CURRENT_DATE,
    expected_return_date DATE,
    returned_at DATE,
    condition_at_return TEXT,
    damage_notes TEXT,
    replacement_charge NUMERIC(8,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_equipment_checkouts_condition_chk
      CHECK (condition_at_return IS NULL OR condition_at_return IN ('GOOD','DAMAGED','LOST')),
    CONSTRAINT ath_equipment_checkouts_dates_chk
      CHECK (expected_return_date IS NULL OR expected_return_date >= checked_out_at),
    CONSTRAINT ath_equipment_checkouts_return_dates_chk
      CHECK (returned_at IS NULL OR returned_at >= checked_out_at),
    CONSTRAINT ath_equipment_checkouts_returned_chk
      CHECK (
        (returned_at IS NULL AND condition_at_return IS NULL)
        OR (returned_at IS NOT NULL AND condition_at_return IS NOT NULL)
      ),
    CONSTRAINT ath_equipment_checkouts_replacement_chk
      CHECK (replacement_charge IS NULL OR replacement_charge >= 0)
);

CREATE INDEX IF NOT EXISTS ath_equipment_checkouts_active_idx
  ON ath_equipment_checkouts(assigned_to_person_id, returned_at)
  WHERE returned_at IS NULL;

CREATE INDEX IF NOT EXISTS ath_equipment_checkouts_equipment_idx
  ON ath_equipment_checkouts(equipment_id, checked_out_at DESC);

CREATE INDEX IF NOT EXISTS ath_equipment_checkouts_overdue_idx
  ON ath_equipment_checkouts(expected_return_date)
  WHERE returned_at IS NULL AND expected_return_date IS NOT NULL;

COMMENT ON TABLE ath_equipment_checkouts IS
  'Per-(equipment, person) checkout audit trail. The Step 2 EquipmentService writes one row per issued item. condition_at_return is nullable while the item is still out — populated to GOOD plus DAMAGED plus LOST at return time. Multi-column returned_chk lockstep keeps returned_at and condition_at_return populated together. Partial INDEX on (assigned_to_person_id, returned_at) WHERE returned_at IS NULL drives the active-checkouts roster view. Partial INDEX on expected_return_date filters the overdue dashboard.';

COMMENT ON COLUMN ath_equipment_checkouts.assigned_to_person_id IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 + ADR-055. The student or staff member the equipment is issued to.';

COMMENT ON COLUMN ath_equipment_checkouts.item_identifier IS
  'Optional uniqueness-helper for the issued item — jersey number, barcode, or serial number. Free-form TEXT.';

COMMENT ON COLUMN ath_equipment_checkouts.replacement_charge IS
  'Optional NUMERIC(8,2). When condition_at_return is DAMAGED or LOST, the Step 2 EquipmentService computes a default from the parent equipment unit_cost and emits ath.equipment.replacement_charge to the Cycle 6 family billing engine. Zero allowed when AD waives the charge.';

CREATE TABLE IF NOT EXISTS ath_safety_equipment (
    id UUID PRIMARY KEY,
    roster_member_id UUID NOT NULL REFERENCES ath_roster_members(id) ON DELETE CASCADE,
    equipment_type TEXT NOT NULL,
    issued BOOLEAN NOT NULL DEFAULT false,
    meets_safety_standard BOOLEAN NOT NULL DEFAULT true,
    certification_date DATE,
    certification_expiry DATE,
    recall_status BOOLEAN NOT NULL DEFAULT false,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_safety_equipment_type_chk
      CHECK (equipment_type IN ('HELMET','PADS','MOUTHGUARD','SHIN_GUARDS','GOGGLES','OTHER')),
    CONSTRAINT ath_safety_equipment_dates_chk
      CHECK (
        certification_expiry IS NULL
        OR certification_date IS NULL
        OR certification_expiry >= certification_date
      )
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_safety_equipment_member_type_uq
  ON ath_safety_equipment(roster_member_id, equipment_type);

CREATE INDEX IF NOT EXISTS ath_safety_equipment_expiry_idx
  ON ath_safety_equipment(certification_expiry)
  WHERE certification_expiry IS NOT NULL;

COMMENT ON TABLE ath_safety_equipment IS
  'Per-(roster_member, equipment_type) safety compliance row. UNIQUE keystone caps each member at one row per safety equipment type — the Step 2 service patches the existing row rather than inserting a new one. issued plus meets_safety_standard plus certification_expiry plus recall_status drive the per-roster compliance checklist. Green when issued AND meets_safety_standard AND certification not expired AND recall_status=false. Amber when expiring within 30 days. Rose when expired or meets_safety_standard=false or recall_status=true.';

CREATE TABLE IF NOT EXISTS ath_conferences (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    sport TEXT NOT NULL,
    region TEXT,
    governing_body TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_conferences_name_chk CHECK (length(trim(name)) > 0),
    CONSTRAINT ath_conferences_sport_chk CHECK (length(trim(sport)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_conferences_name_sport_uq
  ON ath_conferences(name, sport);

CREATE INDEX IF NOT EXISTS ath_conferences_sport_active_idx
  ON ath_conferences(sport, is_active);

COMMENT ON TABLE ath_conferences IS
  'Athletic conference catalogue. Platform-level scope — no school_id because conferences span schools. UNIQUE(name, sport) so a single conference name can host multiple sports as separate rows. The conference physically lives in the tenant schema for now per the M66 .1 plan but is conceptually shareable through the platform routing layer in a future cycle.';

CREATE TABLE IF NOT EXISTS ath_conference_memberships (
    id UUID PRIMARY KEY,
    conference_id UUID NOT NULL REFERENCES ath_conferences(id) ON DELETE CASCADE,
    school_id UUID NOT NULL,
    programme_id UUID NOT NULL REFERENCES ath_programmes(id) ON DELETE CASCADE,
    joined_date DATE NOT NULL DEFAULT CURRENT_DATE,
    level TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_conference_memberships_uq
  ON ath_conference_memberships(conference_id, school_id, programme_id);

CREATE INDEX IF NOT EXISTS ath_conference_memberships_school_idx
  ON ath_conference_memberships(school_id, is_active);

CREATE INDEX IF NOT EXISTS ath_conference_memberships_conference_idx
  ON ath_conference_memberships(conference_id, is_active);

COMMENT ON TABLE ath_conference_memberships IS
  'Per-(conference, school, programme) membership row. UNIQUE keystone caps each programme at one membership per conference. level is the division name within the conference (D1, D2, Premier, etc) — free-form TEXT. is_active flag handles a programme dropping out of a conference without losing the historical membership record.';

COMMENT ON COLUMN ath_conference_memberships.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020. The school whose programme is in this conference.';

CREATE TABLE IF NOT EXISTS ath_conference_schedules (
    id UUID PRIMARY KEY,
    conference_id UUID NOT NULL REFERENCES ath_conferences(id) ON DELETE CASCADE,
    season_id UUID REFERENCES ath_seasons(id) ON DELETE SET NULL,
    home_school_id UUID NOT NULL,
    away_school_id UUID NOT NULL,
    scheduled_date DATE NOT NULL,
    scheduled_time TIME,
    linked_game_id UUID REFERENCES ath_games(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_conference_schedules_schools_chk
      CHECK (home_school_id <> away_school_id)
);

CREATE INDEX IF NOT EXISTS ath_conference_schedules_conf_date_idx
  ON ath_conference_schedules(conference_id, scheduled_date);

CREATE INDEX IF NOT EXISTS ath_conference_schedules_home_idx
  ON ath_conference_schedules(home_school_id, scheduled_date);

CREATE INDEX IF NOT EXISTS ath_conference_schedules_away_idx
  ON ath_conference_schedules(away_school_id, scheduled_date);

COMMENT ON TABLE ath_conference_schedules IS
  'Per-(conference, season) cross-school game slot. home_school_id plus away_school_id plus scheduled_date define the matchup. The linked_game_id is populated by the Step 2 ConferenceService when the actual ath_games row is created from the schedule entry — SET NULL on game delete so the conference schedule survives game cleanup. INDEX on (conference_id, scheduled_date) drives the season schedule grid view.';

COMMENT ON COLUMN ath_conference_schedules.home_school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020. The home team school.';

COMMENT ON COLUMN ath_conference_schedules.away_school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020. The away team school.';

CREATE TABLE IF NOT EXISTS ath_team_photos (
    id UUID PRIMARY KEY,
    roster_id UUID NOT NULL REFERENCES ath_rosters(id) ON DELETE CASCADE,
    photo_type TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    caption TEXT,
    uploaded_by UUID,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_team_photos_type_chk
      CHECK (photo_type IN ('TEAM_PHOTO','ACTION_SHOT','INDIVIDUAL')),
    CONSTRAINT ath_team_photos_s3_chk CHECK (length(trim(s3_key)) > 0)
);

CREATE INDEX IF NOT EXISTS ath_team_photos_roster_idx
  ON ath_team_photos(roster_id, uploaded_at DESC);

COMMENT ON TABLE ath_team_photos IS
  'Per-(roster) team photo or action shot or individual headshot. photo_type 3-value CHECK TEAM_PHOTO, ACTION_SHOT, INDIVIDUAL drives the gallery filter chips. s3_key is the signed-URL pattern matching hr_employee_documents from Cycle 4. CASCADE on parent roster delete since a photo without its roster is meaningless.';

COMMENT ON COLUMN ath_team_photos.uploaded_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 + ADR-055. The staff member who uploaded the photo. Nullable so the schema accommodates anonymous uploads from a future kiosk path.';

CREATE TABLE IF NOT EXISTS ath_media_assets (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    programme_id UUID REFERENCES ath_programmes(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    title TEXT,
    description TEXT,
    season_id UUID REFERENCES ath_seasons(id) ON DELETE SET NULL,
    uploaded_by UUID,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_media_assets_type_chk
      CHECK (asset_type IN ('PHOTO','VIDEO','DOCUMENT','LOGO')),
    CONSTRAINT ath_media_assets_s3_chk CHECK (length(trim(s3_key)) > 0)
);

CREATE INDEX IF NOT EXISTS ath_media_assets_school_programme_type_idx
  ON ath_media_assets(school_id, programme_id, asset_type);

CREATE INDEX IF NOT EXISTS ath_media_assets_season_idx
  ON ath_media_assets(season_id)
  WHERE season_id IS NOT NULL;

COMMENT ON TABLE ath_media_assets IS
  'Per-(school, programme) media asset catalogue. asset_type 4-value CHECK PHOTO, VIDEO, DOCUMENT, LOGO drives the gallery filter chips. Optional season_id link surfaces season-specific media. The Step 2 TeamMediaService writes one row per uploaded asset. INDEX on (school_id, programme_id, asset_type) drives the media gallery filter view.';

COMMENT ON COLUMN ath_media_assets.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020. Denormalised so the media gallery view can scope by school.';

COMMENT ON COLUMN ath_media_assets.programme_id IS
  'DB-enforced FK to ath_programmes(id) ON DELETE CASCADE. Nullable so a school-wide media asset (logo, school crest) is not tied to a specific programme.';

COMMENT ON COLUMN ath_media_assets.uploaded_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 + ADR-055. The staff member who uploaded the asset.';

CREATE TABLE IF NOT EXISTS ath_equipment_maintenance (
    id UUID PRIMARY KEY,
    equipment_id UUID NOT NULL REFERENCES ath_equipment(id) ON DELETE CASCADE,
    maintenance_type TEXT NOT NULL,
    performed_at DATE NOT NULL DEFAULT CURRENT_DATE,
    performed_by TEXT,
    cost NUMERIC(8,2),
    notes TEXT,
    next_maintenance_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_equipment_maintenance_type_chk
      CHECK (maintenance_type IN ('CLEANING','REPAIR','INSPECTION','RECONDITIONING')),
    CONSTRAINT ath_equipment_maintenance_cost_chk
      CHECK (cost IS NULL OR cost >= 0),
    CONSTRAINT ath_equipment_maintenance_dates_chk
      CHECK (next_maintenance_date IS NULL OR next_maintenance_date >= performed_at)
);

CREATE INDEX IF NOT EXISTS ath_equipment_maintenance_equipment_idx
  ON ath_equipment_maintenance(equipment_id, performed_at DESC);

CREATE INDEX IF NOT EXISTS ath_equipment_maintenance_upcoming_idx
  ON ath_equipment_maintenance(next_maintenance_date)
  WHERE next_maintenance_date IS NOT NULL;

COMMENT ON TABLE ath_equipment_maintenance IS
  'Per-equipment maintenance log entry. maintenance_type 4-value CHECK CLEANING, REPAIR, INSPECTION, RECONDITIONING. Append-only audit trail — the Step 2 EquipmentService is the canonical writer through POST /athletics/equipment/:id/maintenance. cost tracks the maintenance expense. next_maintenance_date drives the upcoming-maintenance dashboard view.';

COMMENT ON COLUMN ath_equipment_maintenance.performed_by IS
  'Free-form TEXT — vendor name or in-house staff name. The plan does not require a soft FK to iam_person here because external vendors are common.';
