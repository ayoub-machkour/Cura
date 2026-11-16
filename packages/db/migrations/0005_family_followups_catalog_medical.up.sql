-- =============================================================================
-- 0005 — Comptes famille, RDV de contrôle, soins par médecin, profil médical
-- =============================================================================

-- --- Comptes famille -----------------------------------------------------------
-- Un compte peut gérer d'autres dossiers (enfants, parent âgé…) : chacun garde SON
-- dossier, ses RDV et son historique ; le titulaire du compte réserve et est notifié.
CREATE TYPE family_relationship AS ENUM ('child', 'parent', 'spouse', 'sibling', 'other');

CREATE TABLE patient_guardians (
  user_id      uuid                NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  patient_id   uuid                NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  relationship family_relationship NOT NULL,
  created_by   uuid                REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz         NOT NULL DEFAULT now(),
  CONSTRAINT pk_patient_guardians PRIMARY KEY (user_id, patient_id)
);
CREATE INDEX ix_patient_guardians_patient ON patient_guardians (patient_id);

-- --- RDV de contrôle -----------------------------------------------------------
-- Le médecin fixe le prochain RDV : il reste rattaché à la visite qui l'a motivé.
ALTER TABLE appointments
  ADD COLUMN follow_up_of uuid REFERENCES appointments (id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_appointments_follow_up_not_self CHECK (follow_up_of IS NULL OR follow_up_of <> id);
CREATE INDEX ix_appointments_follow_up ON appointments (follow_up_of) WHERE follow_up_of IS NOT NULL;

-- --- Soins / motifs par médecin ------------------------------------------------
-- doctor_id NULL = motif commun au cabinet ; sinon soin propre à un médecin (avec SON prix).
ALTER TABLE appointment_types ADD COLUMN doctor_id uuid REFERENCES doctors (id) ON DELETE RESTRICT;
ALTER TABLE appointment_types DROP CONSTRAINT uq_appointment_types_code;
ALTER TABLE appointment_types ADD CONSTRAINT uq_appointment_types_code UNIQUE NULLS NOT DISTINCT (doctor_id, code);
CREATE INDEX ix_appointment_types_doctor ON appointment_types (doctor_id) WHERE is_active;

-- --- Profil médical déclaratif -------------------------------------------------
CREATE TYPE blood_type AS ENUM ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-');

-- Liste de libellés courts : bornée, trimée, sans balise HTML (miroir de MedicalList côté Zod).
CREATE FUNCTION is_clean_text_list(items text[], max_items integer, max_len integer)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(items) <= max_items
     AND NOT EXISTS (
       SELECT 1 FROM unnest(items) AS e
        WHERE e IS NULL OR e <> btrim(e) OR char_length(e) NOT BETWEEN 1 AND max_len OR e ~ '<[a-zA-Z/!?]'
     )
$$;

CREATE TABLE patient_medical_profiles (
  patient_id              uuid        PRIMARY KEY REFERENCES patients (id) ON DELETE RESTRICT,
  blood_type              blood_type,
  allergies               text[]      NOT NULL DEFAULT '{}' CONSTRAINT ck_profile_allergies   CHECK (is_clean_text_list(allergies, 30, 120)),
  chronic_conditions      text[]      NOT NULL DEFAULT '{}' CONSTRAINT ck_profile_conditions  CHECK (is_clean_text_list(chronic_conditions, 30, 120)),
  current_medications     text[]      NOT NULL DEFAULT '{}' CONSTRAINT ck_profile_medications CHECK (is_clean_text_list(current_medications, 30, 120)),
  past_surgeries          text[]      NOT NULL DEFAULT '{}' CONSTRAINT ck_profile_surgeries   CHECK (is_clean_text_list(past_surgeries, 30, 120)),
  emergency_contact_name  person_name,
  emergency_contact_phone phone_e164,
  notes                   safe_text   CONSTRAINT ck_profile_notes CHECK (char_length(notes) <= 2000),
  updated_by              uuid        REFERENCES users (id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_profile_emergency_contact CHECK ((emergency_contact_name IS NULL) = (emergency_contact_phone IS NULL))
);

-- Traçabilité des données de santé : QUI a modifié QUELS champs, QUAND (sans recopier les valeurs).
CREATE TABLE patient_medical_profile_changes (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id    uuid        NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  fields        text[]      NOT NULL CONSTRAINT ck_profile_changes_fields CHECK (cardinality(fields) > 0),
  actor_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  actor_role    user_role   NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_profile_changes_patient ON patient_medical_profile_changes (patient_id, changed_at);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER trg_profile_changes_append_only BEFORE UPDATE OR DELETE ON patient_medical_profile_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
