-- =============================================================================
-- 0003 — Parcours de visite (file d'attente) et historique des statuts
--
-- scheduled → confirmed → checked_in → in_consultation → completed
--         ↘ cancelled          ↘ no_show
-- La base garantit la cohérence des horodatages et l'unicité de la consultation
-- en cours par médecin, quel que soit le code applicatif.
-- =============================================================================

ALTER TABLE appointments
  ADD COLUMN consultation_started_at timestamptz,
  ADD COLUMN completed_at            timestamptz,
  ADD COLUMN no_show_at              timestamptz;

-- Chaque statut porte l'horodatage qui le justifie.
ALTER TABLE appointments
  ADD CONSTRAINT ck_appointments_consultation CHECK (
    status NOT IN ('in_consultation', 'completed')
    OR (checked_in_at IS NOT NULL AND consultation_started_at IS NOT NULL)
  ),
  ADD CONSTRAINT ck_appointments_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  ADD CONSTRAINT ck_appointments_no_show   CHECK ((status = 'no_show')   = (no_show_at IS NOT NULL)),
  -- Chronologie : arrivée ≤ début de consultation ≤ fin.
  ADD CONSTRAINT ck_appointments_chronology CHECK (
        (consultation_started_at IS NULL OR checked_in_at IS NULL OR consultation_started_at >= checked_in_at)
    AND (completed_at IS NULL OR consultation_started_at IS NULL OR completed_at >= consultation_started_at)
  );

-- Un médecin ne reçoit qu'UN patient à la fois.
CREATE UNIQUE INDEX uq_appointments_one_consultation_per_doctor
  ON appointments (doctor_id)
  WHERE status = 'in_consultation';

-- Historique immuable des changements de statut (traçabilité : qui, quoi, quand).
CREATE TABLE appointment_status_changes (
  id             bigint             GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id uuid               NOT NULL REFERENCES appointments (id) ON DELETE RESTRICT,
  from_status    appointment_status,               -- NULL à la création
  to_status      appointment_status NOT NULL,
  actor_user_id  uuid               REFERENCES users (id) ON DELETE SET NULL, -- NULL = système
  occurred_at    timestamptz        NOT NULL DEFAULT now(),
  CONSTRAINT ck_status_changes_differs CHECK (from_status IS DISTINCT FROM to_status)
);
CREATE INDEX ix_status_changes_appointment ON appointment_status_changes (appointment_id, occurred_at);

-- L'historique ne se modifie ni ne se supprime.
CREATE FUNCTION forbid_status_change_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'appointment_status_changes is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER trg_status_changes_append_only BEFORE UPDATE OR DELETE ON appointment_status_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_status_change_mutation();

-- Purge des événements déjà publiés (relais de l'outbox).
CREATE INDEX ix_outbox_published ON outbox_events (published_at) WHERE published_at IS NOT NULL;
