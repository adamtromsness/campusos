/*
 * 145_sis_behaviour_advanced.sql — Phase 2 Cycle 14 (P2-14).
 *
 * M20 Behaviour .1 — Behaviour Advanced. 5 new tenant base tables on
 * top of the Cycle 9 discipline schema (sis_discipline_incidents +
 * sis_discipline_actions + sis_discipline_categories). Adds the
 * restorative + preventive layer to the discipline model.
 *
 *   sis_restorative_justice_conferences
 *     Restorative justice conference structured around a Cycle 9
 *     discipline incident. Brings the offending student plus harmed
 *     party plus a trained facilitator together to negotiate a
 *     written agreement. 5-value status CHECK (SCHEDULED IN_PROGRESS
 *     AGREEMENT_REACHED RESOLVED_SUCCESSFULLY FAILED). harmed_party_ids
 *     is a UUID[] of soft refs to sis_students because a single
 *     incident can harm multiple parties. Emits
 *     beh.rj_conference.resolved when the conference flips to
 *     RESOLVED_SUCCESSFULLY by the auto-transition path in
 *     RestorativeJusticeService when every agreement action lands
 *     COMPLETED. INDEX(school_id status).
 *   sis_rj_agreement_actions
 *     One row per action item written into the conference agreement.
 *     3-value status CHECK (PENDING COMPLETED OVERDUE). Multi-column
 *     completed_chk pins (completed_at verified_by) populated only
 *     when status equals COMPLETED. The OverdueActionWorker nightly
 *     sweep flips PENDING rows whose due_date is past today to
 *     OVERDUE plus emits the facilitator notification. When ALL
 *     actions for a conference end up COMPLETED the RJ service
 *     auto-transitions the parent conference to RESOLVED_SUCCESSFULLY
 *     in the same tenant tx as the action update. INDEX(conference_id
 *     status).
 *   sis_peer_mediations
 *     Lower-tier conflict resolution between two students with a
 *     trained peer mediator facilitating. 4-value status CHECK
 *     (REFERRED SCHEDULED RESOLVED UNRESOLVED). Multi-column
 *     parties_chk enforces party_a_student_id is not equal to
 *     party_b_student_id so two parties cannot share the same row.
 *     Multi-column mediator_chk enforces the mediator is not one of
 *     the two parties. is_mediator_trained gates the assignment
 *     surface — the Step 4 PeerMediationService filters mediator
 *     candidates to is_mediator_trained equals true. INDEX(school_id
 *     status).
 *   sis_positive_behaviour_points
 *     Per-(school student) positive behaviour ledger row. transaction_type
 *     2-value CHECK (AWARD REDEMPTION) distinguishes positive awards
 *     from reward redemptions. points is always positive at the
 *     schema layer plus the direction is carried by transaction_type
 *     mirroring the Cycle 6 pay_ledger_entries pattern. category is
 *     a free-form school-configured token sourced from the
 *     platform_tenant_configs positive_behaviour_categories JSONB
 *     setting. Multi-column redemption_chk pins (reward_id) populated
 *     only when transaction_type equals REDEMPTION plus reward_id
 *     null on AWARD rows. The Step 4 PositiveBehaviourService
 *     computes student balance as SUM(points) for AWARD rows minus
 *     SUM(points) for REDEMPTION rows in the same school. Emits
 *     beh.positive_points.awarded on every AWARD insert for the
 *     Cycle 3 NotificationConsumer pipeline. INDEX(student_id
 *     awarded_at DESC).
 *   sis_behaviour_rewards
 *     Per-school rewards marketplace catalogue. 4-value reward_type
 *     CHECK (INDIVIDUAL CLASS DIGITAL PHYSICAL). points_cost positive
 *     integer CHECK. quantity_available nullable for unlimited rewards
 *     (digital badges, lunch with teacher) plus a positive integer
 *     for finite rewards (stickers, prize bin items). is_active flag
 *     for soft deactivation since deleting a reward with historical
 *     redemption rows breaks audit. UNIQUE(school_id reward_name).
 *
 * Soft FKs per ADR-001 and ADR-020 (not enforced at the schema layer
 * but validated by the request-path service layer against the calling
 * tenant before INSERT):
 *   sis_restorative_justice_conferences.school_id   -> platform.schools(id)
 *   sis_restorative_justice_conferences.harmed_party_ids[]
 *                                                   -> sis_students(id) soft array
 *   sis_peer_mediations.school_id                   -> platform.schools(id)
 *   sis_positive_behaviour_points.school_id         -> platform.schools(id)
 *   sis_behaviour_rewards.school_id                 -> platform.schools(id)
 *
 * DB-enforced intra-tenant FKs:
 *   sis_restorative_justice_conferences.incident_id        -> sis_discipline_incidents(id) ON DELETE CASCADE
 *     The conference has no meaning without the originating incident.
 *   sis_restorative_justice_conferences.facilitator_id     -> hr_employees(id) ON DELETE SET NULL
 *     Audit row survives the counsellor leaving the school.
 *   sis_restorative_justice_conferences.offender_student_id -> sis_students(id) ON DELETE CASCADE
 *     Conference belongs to the offending student record.
 *   sis_rj_agreement_actions.conference_id                 -> sis_restorative_justice_conferences(id) ON DELETE CASCADE
 *     Actions are meaningless without their parent conference.
 *   sis_rj_agreement_actions.assigned_to_student_id        -> sis_students(id) ON DELETE CASCADE
 *   sis_rj_agreement_actions.verified_by                   -> hr_employees(id) ON DELETE SET NULL
 *   sis_peer_mediations.mediator_student_id                -> sis_students(id) ON DELETE CASCADE
 *   sis_peer_mediations.party_a_student_id                 -> sis_students(id) ON DELETE CASCADE
 *   sis_peer_mediations.party_b_student_id                 -> sis_students(id) ON DELETE CASCADE
 *   sis_peer_mediations.referred_by                        -> hr_employees(id) ON DELETE SET NULL
 *   sis_positive_behaviour_points.student_id               -> sis_students(id) ON DELETE CASCADE
 *   sis_positive_behaviour_points.awarded_by               -> hr_employees(id) ON DELETE SET NULL
 *   sis_positive_behaviour_points.reward_id                -> sis_behaviour_rewards(id) ON DELETE SET NULL
 *
 * 0 cross-schema FKs. Block comment header. No semicolons inside any
 * string literal or comment per the splitter trap from prior cycles.
 */

CREATE TABLE IF NOT EXISTS sis_restorative_justice_conferences (
  id                     UUID PRIMARY KEY,
  school_id              UUID NOT NULL,
  incident_id            UUID NOT NULL REFERENCES sis_discipline_incidents(id) ON DELETE CASCADE,
  facilitator_id         UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  offender_student_id    UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  harmed_party_ids       UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  parent_notified_at     TIMESTAMPTZ,
  conference_date        TIMESTAMPTZ,
  conference_location    TEXT,
  conference_notes       TEXT,
  status                 TEXT NOT NULL DEFAULT 'SCHEDULED',
  resolution_date        TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_rj_conf_status_chk CHECK (
    status IN ('SCHEDULED','IN_PROGRESS','AGREEMENT_REACHED','RESOLVED_SUCCESSFULLY','FAILED')
  ),
  CONSTRAINT sis_rj_conf_harmed_parties_chk CHECK (
    cardinality(harmed_party_ids) > 0
  ),
  CONSTRAINT sis_rj_conf_resolved_chk CHECK (
    (status IN ('SCHEDULED','IN_PROGRESS','AGREEMENT_REACHED') AND resolution_date IS NULL)
    OR (status IN ('RESOLVED_SUCCESSFULLY','FAILED') AND resolution_date IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sis_rj_conf_school_status_idx
  ON sis_restorative_justice_conferences (school_id, status);

CREATE INDEX IF NOT EXISTS sis_rj_conf_incident_idx
  ON sis_restorative_justice_conferences (incident_id);

CREATE INDEX IF NOT EXISTS sis_rj_conf_offender_idx
  ON sis_restorative_justice_conferences (offender_student_id);

COMMENT ON TABLE sis_restorative_justice_conferences IS
  'Restorative justice conference structured around a Cycle 9 discipline incident. 5-value status SCHEDULED IN_PROGRESS AGREEMENT_REACHED RESOLVED_SUCCESSFULLY FAILED. Auto-transitions to RESOLVED_SUCCESSFULLY when every agreement action lands COMPLETED.';

COMMENT ON COLUMN sis_restorative_justice_conferences.harmed_party_ids IS
  'Soft array ref to sis_students(id) per ADR-001 and ADR-020. A single incident can harm multiple parties so the schema carries an array rather than a single FK column. The Step 3 service validates every UUID against the calling tenant before INSERT.';

CREATE TABLE IF NOT EXISTS sis_rj_agreement_actions (
  id                          UUID PRIMARY KEY,
  conference_id               UUID NOT NULL REFERENCES sis_restorative_justice_conferences(id) ON DELETE CASCADE,
  action_description          TEXT NOT NULL,
  assigned_to_student_id      UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  due_date                    DATE NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'PENDING',
  completed_at                TIMESTAMPTZ,
  verified_by                 UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  evidence_notes              TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_rj_action_status_chk CHECK (
    status IN ('PENDING','COMPLETED','OVERDUE')
  ),
  CONSTRAINT sis_rj_action_completed_chk CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL AND verified_by IS NOT NULL)
    OR (status IN ('PENDING','OVERDUE') AND completed_at IS NULL AND verified_by IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS sis_rj_action_conference_status_idx
  ON sis_rj_agreement_actions (conference_id, status);

CREATE INDEX IF NOT EXISTS sis_rj_action_overdue_sweep_idx
  ON sis_rj_agreement_actions (due_date, status)
  WHERE status = 'PENDING';

COMMENT ON TABLE sis_rj_agreement_actions IS
  'Agreement action item produced by a restorative justice conference. 3-value status PENDING COMPLETED OVERDUE. Multi-column completed_chk pins completed_at plus verified_by populated together when status is COMPLETED and both null otherwise. OverdueActionWorker nightly sweep flips PENDING rows past due_date to OVERDUE.';

COMMENT ON COLUMN sis_rj_agreement_actions.completed_at IS
  'Multi-column completed_chk lockstep keeps completed_at plus verified_by all-set on COMPLETED and all-null on PENDING or OVERDUE. The Step 3 RJ service stamps both atomically inside the same tx as the status flip.';

CREATE TABLE IF NOT EXISTS sis_peer_mediations (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  mediator_student_id      UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  party_a_student_id       UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  party_b_student_id       UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  referred_by              UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  conflict_description     TEXT NOT NULL,
  mediation_date           TIMESTAMPTZ,
  outcome                  TEXT,
  status                   TEXT NOT NULL DEFAULT 'REFERRED',
  is_mediator_trained      BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_peer_med_status_chk CHECK (
    status IN ('REFERRED','SCHEDULED','RESOLVED','UNRESOLVED')
  ),
  CONSTRAINT sis_peer_med_parties_chk CHECK (
    party_a_student_id <> party_b_student_id
  ),
  CONSTRAINT sis_peer_med_mediator_chk CHECK (
    mediator_student_id <> party_a_student_id
    AND mediator_student_id <> party_b_student_id
  )
);

CREATE INDEX IF NOT EXISTS sis_peer_med_school_status_idx
  ON sis_peer_mediations (school_id, status);

CREATE INDEX IF NOT EXISTS sis_peer_med_mediator_idx
  ON sis_peer_mediations (mediator_student_id);

COMMENT ON TABLE sis_peer_mediations IS
  'Lower-tier conflict resolution between two students with a trained peer mediator facilitating. 4-value status REFERRED SCHEDULED RESOLVED UNRESOLVED. CHECK constraints reject self-mediation plus same-party pairs at the schema layer.';

COMMENT ON CONSTRAINT sis_peer_med_mediator_chk ON sis_peer_mediations IS
  'Mediator cannot be one of the two parties to the conflict. Caught at the schema layer rather than the service so a buggy service cannot land an invalid row.';

CREATE TABLE IF NOT EXISTS sis_behaviour_rewards (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  reward_name              TEXT NOT NULL,
  description              TEXT,
  points_cost              INT NOT NULL,
  reward_type              TEXT NOT NULL,
  quantity_available       INT,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_beh_reward_type_chk CHECK (
    reward_type IN ('INDIVIDUAL','CLASS','DIGITAL','PHYSICAL')
  ),
  CONSTRAINT sis_beh_reward_points_chk CHECK (
    points_cost > 0
  ),
  CONSTRAINT sis_beh_reward_quantity_chk CHECK (
    quantity_available IS NULL OR quantity_available >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sis_beh_reward_name_uq
  ON sis_behaviour_rewards (school_id, reward_name);

CREATE INDEX IF NOT EXISTS sis_beh_reward_school_active_idx
  ON sis_behaviour_rewards (school_id, is_active);

COMMENT ON TABLE sis_behaviour_rewards IS
  'Per-school rewards marketplace catalogue. 4-value reward_type INDIVIDUAL CLASS DIGITAL PHYSICAL. quantity_available null for unlimited rewards. UNIQUE(school_id reward_name). Soft-deactivate via is_active equals false rather than DELETE since redemption rows reference reward_id via SET NULL.';

CREATE TABLE IF NOT EXISTS sis_positive_behaviour_points (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  student_id               UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  awarded_by               UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  transaction_type         TEXT NOT NULL DEFAULT 'AWARD',
  category                 TEXT,
  points                   INT NOT NULL,
  reason                   TEXT NOT NULL,
  reward_id                UUID REFERENCES sis_behaviour_rewards(id) ON DELETE SET NULL,
  awarded_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_pos_pts_type_chk CHECK (
    transaction_type IN ('AWARD','REDEMPTION')
  ),
  CONSTRAINT sis_pos_pts_points_chk CHECK (
    points > 0
  ),
  CONSTRAINT sis_pos_pts_redemption_chk CHECK (
    (transaction_type = 'AWARD' AND reward_id IS NULL AND category IS NOT NULL)
    OR (transaction_type = 'REDEMPTION' AND reward_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sis_pos_pts_student_awarded_idx
  ON sis_positive_behaviour_points (student_id, awarded_at DESC);

CREATE INDEX IF NOT EXISTS sis_pos_pts_school_type_idx
  ON sis_positive_behaviour_points (school_id, transaction_type);

CREATE INDEX IF NOT EXISTS sis_pos_pts_reward_idx
  ON sis_positive_behaviour_points (reward_id)
  WHERE reward_id IS NOT NULL;

COMMENT ON TABLE sis_positive_behaviour_points IS
  'Per-(school student) positive behaviour ledger. transaction_type 2-value AWARD REDEMPTION distinguishes positive awards from reward redemptions. points always positive at the schema layer per CHECK greater than 0 plus direction carried by transaction_type mirroring Cycle 6 pay_ledger_entries. Student balance equals SUM(points) for AWARD rows minus SUM(points) for REDEMPTION rows.';

COMMENT ON COLUMN sis_positive_behaviour_points.transaction_type IS
  'AWARD when a teacher recognises positive behaviour. REDEMPTION when the student spends points on a sis_behaviour_rewards entry. Multi-column redemption_chk lockstep enforces category populated on AWARD plus reward_id populated on REDEMPTION.';
