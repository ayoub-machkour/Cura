-- =============================================================================
-- 0004 — Patients sans rendez-vous (walk-in) et activation de compte par invitation
-- =============================================================================

-- --- Walk-in -------------------------------------------------------------------
-- Une visite sans créneau (slot_id NULL) entre directement en salle d'attente : elle
-- est gérée par la FILE, pas par l'agenda. Les exclusions de chevauchement ne
-- s'appliquent donc qu'aux rendez-vous sur créneau.
ALTER TABLE appointments DROP CONSTRAINT ex_appointments_doctor_overlap;
ALTER TABLE appointments ADD CONSTRAINT ex_appointments_doctor_overlap EXCLUDE USING gist (
  doctor_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status NOT IN ('cancelled', 'no_show') AND slot_id IS NOT NULL);

ALTER TABLE appointments DROP CONSTRAINT ex_appointments_patient_overlap;
ALTER TABLE appointments ADD CONSTRAINT ex_appointments_patient_overlap EXCLUDE USING gist (
  patient_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status NOT IN ('cancelled', 'no_show') AND slot_id IS NOT NULL);

-- Un patient n'est présent qu'UNE fois dans les files d'attente (walk-in ou RDV).
CREATE UNIQUE INDEX uq_appointments_patient_in_queue
  ON appointments (patient_id)
  WHERE status IN ('checked_in', 'in_consultation');

-- Un walk-in est enregistré à son arrivée : il n'existe jamais sans heure d'arrivée.
ALTER TABLE appointments ADD CONSTRAINT ck_appointments_walk_in CHECK (
  slot_id IS NOT NULL OR status IN ('checked_in', 'in_consultation', 'completed', 'cancelled', 'no_show')
);

-- --- Invitations (rattachement d'un compte mobile à un dossier existant) ---------
-- Le code n'est JAMAIS stocké en clair : seule son empreinte SHA-256 l'est.
CREATE TABLE patient_invitations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      uuid        NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  code_hash       char(64)    NOT NULL CONSTRAINT ck_invitations_hash CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  revoked_at      timestamptz,
  failed_attempts integer     NOT NULL DEFAULT 0 CONSTRAINT ck_invitations_attempts CHECK (failed_attempts BETWEEN 0 AND 10),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_invitations_code UNIQUE (code_hash),
  CONSTRAINT ck_invitations_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_invitations_final_state CHECK (used_at IS NULL OR revoked_at IS NULL)
);
-- Au plus UNE invitation active par patient.
CREATE UNIQUE INDEX uq_invitations_one_active_per_patient
  ON patient_invitations (patient_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;
