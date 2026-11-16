-- =============================================================================
-- 0001 — Schéma métier de base
--
-- Exécutée dans UNE transaction par le migrateur (ne pas écrire BEGIN/COMMIT).
-- Les CHECK reprennent exactement packages/shared/src/constraints.ts.
-- Une migration appliquée ne se modifie JAMAIS : toute évolution = nouvelle migration.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- EXCLUDE combinant égalité (uuid) + chevauchement (tstzrange)
CREATE EXTENSION IF NOT EXISTS citext;      -- emails insensibles à la casse
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- recherche patient tolérante (ILIKE indexé)

-- -----------------------------------------------------------------------------
-- Types énumérés
-- -----------------------------------------------------------------------------
CREATE TYPE slot_status        AS ENUM ('open', 'blocked');
CREATE TYPE appointment_status AS ENUM (
  'scheduled', 'confirmed', 'checked_in', 'in_consultation', 'completed', 'cancelled', 'no_show'
);
CREATE TYPE booking_source     AS ENUM ('mobile', 'desk', 'phone');
CREATE TYPE invoice_status     AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'void');
CREATE TYPE payment_method     AS ENUM ('cash', 'card', 'check', 'transfer', 'insurance');

-- -----------------------------------------------------------------------------
-- Domaines réutilisables : une règle, un seul endroit en SQL.
-- -----------------------------------------------------------------------------
-- LIMITS.personName (1..100) + PATTERNS.personName : trimé, sans chiffre, sans <>, sans contrôle.
CREATE DOMAIN person_name AS text
  CHECK (VALUE = btrim(VALUE) AND char_length(VALUE) BETWEEN 1 AND 100 AND VALUE ~ '^[^0-9<>[:cntrl:]]+$');

-- PATTERNS.phoneE164
CREATE DOMAIN phone_e164 AS text
  CHECK (VALUE ~ '^\+[1-9][0-9]{6,14}$');

-- LIMITS.email + PATTERNS.email (stocké en minuscules par l'API ; citext garantit l'unicité insensible à la casse).
CREATE DOMAIN email_address AS citext
  CHECK (char_length(VALUE) <= 254 AND VALUE ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- PATTERNS.noHtmlTag : texte libre sans balise HTML (anti-XSS stocké).
CREATE DOMAIN safe_text AS text
  CHECK (VALUE !~ '<[a-zA-Z/!?]');

CREATE DOMAIN hex_color AS text
  CHECK (VALUE ~ '^#[0-9A-Fa-f]{6}$');

CREATE DOMAIN money_cents AS bigint
  CHECK (VALUE BETWEEN 0 AND 100000000);

-- -----------------------------------------------------------------------------
-- Utilitaire : updated_at automatique
-- -----------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- doctors
-- -----------------------------------------------------------------------------
CREATE TABLE doctors (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name          person_name NOT NULL,
  last_name           person_name NOT NULL,
  specialty           text        NOT NULL,
  registration_number text        NOT NULL,
  timezone            text        NOT NULL DEFAULT 'UTC',
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_doctors_specialty CHECK (
    specialty = btrim(specialty) AND char_length(specialty) BETWEEN 2 AND 100
    AND specialty ~ '^[^0-9<>[:cntrl:]]+$'
  ),
  CONSTRAINT ck_doctors_registration CHECK (
    char_length(registration_number) BETWEEN 3 AND 32 AND registration_number ~ '^[A-Za-z0-9/-]+$'
  ),
  CONSTRAINT ck_doctors_timezone CHECK (char_length(timezone) BETWEEN 1 AND 64),
  CONSTRAINT uq_doctors_registration UNIQUE (registration_number)
);
CREATE INDEX ix_doctors_active_name ON doctors (lower(last_name), lower(first_name), id) WHERE is_active;
CREATE TRIGGER trg_doctors_updated_at BEFORE UPDATE ON doctors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- patients
-- Pas d'UNIQUE sur téléphone / email : un parent gère souvent le dossier de ses
-- enfants avec ses propres coordonnées.
-- -----------------------------------------------------------------------------
CREATE TABLE patients (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name  person_name   NOT NULL,
  last_name   person_name   NOT NULL,
  -- La borne "pas dans le futur" est vérifiée par Zod : current_date n'est pas
  -- autorisée dans un CHECK (non immuable).
  birth_date  date          NOT NULL CONSTRAINT ck_patients_birth_date CHECK (birth_date >= DATE '1900-01-01'),
  sex         char(1)       CONSTRAINT ck_patients_sex CHECK (sex IN ('F', 'M', 'X')),
  phone       phone_e164    NOT NULL,
  email       email_address,
  national_id text          CONSTRAINT ck_patients_national_id CHECK (
                              char_length(national_id) BETWEEN 4 AND 32 AND national_id ~ '^[A-Za-z0-9-]+$'
                            ),
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX uq_patients_national_id
  ON patients (national_id) WHERE national_id IS NOT NULL AND deleted_at IS NULL;
-- Pagination alphabétique (keyset) : correspond exactement au ORDER BY du repository.
CREATE INDEX ix_patients_alpha ON patients (lower(last_name), lower(first_name), id) WHERE deleted_at IS NULL;
-- Recherche "contient" (nom, prénom) via trigrammes : ILIKE '%dup%' utilise l'index.
CREATE INDEX ix_patients_search_trgm ON patients
  USING gin ((lower(last_name || ' ' || first_name)) gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX ix_patients_phone ON patients (phone) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_patients_updated_at BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- appointment_types (motifs) — couleur d'agenda et durée
-- -----------------------------------------------------------------------------
CREATE TABLE appointment_types (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text        NOT NULL CONSTRAINT ck_appointment_types_code CHECK (code ~ '^[A-Z0-9_]{2,32}$'),
  label               safe_text   NOT NULL CONSTRAINT ck_appointment_types_label CHECK (
                                    label = btrim(label) AND char_length(label) BETWEEN 1 AND 120
                                  ),
  duration_minutes    integer     NOT NULL CONSTRAINT ck_appointment_types_duration CHECK (
                                    duration_minutes BETWEEN 5 AND 240 AND duration_minutes % 5 = 0
                                  ),
  color_hex           hex_color   NOT NULL,
  bookable_online     boolean     NOT NULL DEFAULT true,
  default_price_cents money_cents NOT NULL DEFAULT 0,
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_appointment_types_code UNIQUE (code)
);
CREATE TRIGGER trg_appointment_types_updated_at BEFORE UPDATE ON appointment_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- slots — créneaux générés depuis le planning du médecin
-- "Réservé" n'est pas stocké ici : c'est l'existence d'un RDV actif.
-- -----------------------------------------------------------------------------
CREATE TABLE slots (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       uuid        NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  status          slot_status NOT NULL DEFAULT 'open',
  online_bookable boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- LIMITS.slotDurationMinutes (5..240)
  CONSTRAINT ck_slots_duration CHECK (
    ends_at - starts_at BETWEEN interval '5 minutes' AND interval '240 minutes'
  ),
  CONSTRAINT uq_slots_doctor_start UNIQUE (doctor_id, starts_at),
  CONSTRAINT uq_slots_identity UNIQUE (id, doctor_id, starts_at, ends_at),
  CONSTRAINT ex_slots_no_overlap EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
);

-- -----------------------------------------------------------------------------
-- appointments
-- -----------------------------------------------------------------------------
CREATE TABLE appointments (
  id                  uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id           uuid               NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
  patient_id          uuid               NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  appointment_type_id uuid               NOT NULL REFERENCES appointment_types (id) ON DELETE RESTRICT,
  slot_id             uuid,
  starts_at           timestamptz        NOT NULL,
  ends_at             timestamptz        NOT NULL,
  status              appointment_status NOT NULL DEFAULT 'scheduled',
  source              booking_source     NOT NULL,
  idempotency_key     uuid               NOT NULL,
  note                safe_text          CONSTRAINT ck_appointments_note CHECK (char_length(note) <= 500),
  confirmed_at        timestamptz,
  checked_in_at       timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       safe_text          CONSTRAINT ck_appointments_cancel_reason CHECK (char_length(cancel_reason) <= 300),
  version             integer            NOT NULL DEFAULT 1 CONSTRAINT ck_appointments_version CHECK (version >= 1),
  created_at          timestamptz        NOT NULL DEFAULT now(),
  updated_at          timestamptz        NOT NULL DEFAULT now(),

  CONSTRAINT ck_appointments_range CHECK (ends_at > starts_at),
  CONSTRAINT ck_appointments_cancel CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT ck_appointments_checkin CHECK (
    status NOT IN ('checked_in', 'in_consultation') OR checked_in_at IS NOT NULL
  ),

  -- Le RDV hérite EXACTEMENT du médecin et des horaires de son créneau
  -- (MATCH SIMPLE : ignoré quand slot_id est NULL → walk-in).
  CONSTRAINT fk_appointments_slot FOREIGN KEY (slot_id, doctor_id, starts_at, ends_at)
    REFERENCES slots (id, doctor_id, starts_at, ends_at) ON DELETE RESTRICT,

  CONSTRAINT uq_appointments_idempotency UNIQUE (patient_id, idempotency_key),

  -- GARDE-FOU 1 : aucun chevauchement de RDV actifs pour un médecin.
  CONSTRAINT ex_appointments_doctor_overlap EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled', 'no_show')),

  -- GARDE-FOU 2 : un patient ne peut pas être à deux RDV en même temps.
  CONSTRAINT ex_appointments_patient_overlap EXCLUDE USING gist (
    patient_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled', 'no_show'))
);

-- GARDE-FOU 3 : un seul RDV actif par créneau.
CREATE UNIQUE INDEX uq_appointments_active_slot
  ON appointments (slot_id)
  WHERE slot_id IS NOT NULL AND status NOT IN ('cancelled', 'no_show');

-- Agenda d'un médecin sur une période (keyset starts_at, id).
CREATE INDEX ix_appointments_doctor_time  ON appointments (doctor_id, starts_at, id);
-- "Mes rendez-vous" côté patient (keyset starts_at, id).
CREATE INDEX ix_appointments_patient_time ON appointments (patient_id, starts_at, id);
-- File d'attente live : ne contient que les patients présents.
CREATE INDEX ix_appointments_queue ON appointments (doctor_id, checked_in_at)
  WHERE status IN ('checked_in', 'in_consultation');

CREATE TRIGGER trg_appointments_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Facturation — montants en centimes (jamais de float pour de l'argent)
-- -----------------------------------------------------------------------------
-- Numérotation SANS TROU (obligation légale) : une SEQUENCE peut créer des trous.
CREATE TABLE invoice_counters (
  year       integer PRIMARY KEY CONSTRAINT ck_invoice_counters_year CHECK (year BETWEEN 2000 AND 2999),
  last_value integer NOT NULL DEFAULT 0 CONSTRAINT ck_invoice_counters_value CHECK (last_value >= 0)
);

CREATE TABLE invoices (
  id             uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text           CONSTRAINT ck_invoices_number CHECK (number ~ '^[0-9]{4}-[0-9]{6}$'),
  patient_id     uuid           NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  appointment_id uuid           REFERENCES appointments (id) ON DELETE RESTRICT,
  status         invoice_status NOT NULL DEFAULT 'draft',
  currency       char(3)        NOT NULL CONSTRAINT ck_invoices_currency CHECK (currency ~ '^[A-Z]{3}$'),
  total_cents    bigint         NOT NULL DEFAULT 0 CONSTRAINT ck_invoices_total CHECK (total_cents >= 0),
  paid_cents     bigint         NOT NULL DEFAULT 0 CONSTRAINT ck_invoices_paid_positive CHECK (paid_cents >= 0),
  issued_at      timestamptz,
  created_by     uuid,
  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT uq_invoices_number UNIQUE (number),
  CONSTRAINT uq_invoices_appointment UNIQUE (appointment_id),
  CONSTRAINT ck_invoices_issued CHECK (status = 'draft' OR (number IS NOT NULL AND issued_at IS NOT NULL)),
  CONSTRAINT ck_invoices_paid CHECK (paid_cents <= total_cents)
);
CREATE INDEX ix_invoices_issued_day ON invoices (issued_at) WHERE status <> 'draft';
CREATE INDEX ix_invoices_patient    ON invoices (patient_id, created_at DESC);
CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid        NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  act_code         text        NOT NULL CONSTRAINT ck_invoice_items_act_code CHECK (act_code ~ '^[A-Z0-9_.-]{1,32}$'),
  label            safe_text   NOT NULL CONSTRAINT ck_invoice_items_label CHECK (char_length(label) BETWEEN 1 AND 200),
  quantity         integer     NOT NULL CONSTRAINT ck_invoice_items_quantity CHECK (quantity BETWEEN 1 AND 1000),
  unit_price_cents money_cents NOT NULL,
  line_total_cents bigint      GENERATED ALWAYS AS (quantity * unit_price_cents) STORED
);
CREATE INDEX ix_invoice_items_invoice ON invoice_items (invoice_id);

CREATE TABLE payments (
  id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid           NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  amount_cents bigint         NOT NULL CONSTRAINT ck_payments_amount CHECK (amount_cents BETWEEN 1 AND 100000000),
  method       payment_method NOT NULL,
  paid_at      timestamptz    NOT NULL DEFAULT now(),
  received_by  uuid
);
CREATE INDEX ix_payments_invoice ON payments (invoice_id);
CREATE INDEX ix_payments_day     ON payments (paid_at);

-- Une facture émise est IMMUABLE ; toute correction passe par un avoir.
CREATE FUNCTION guard_issued_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.number      IS DISTINCT FROM OLD.number
    OR NEW.patient_id  IS DISTINCT FROM OLD.patient_id
    OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
    OR NEW.currency    IS DISTINCT FROM OLD.currency
    OR NEW.issued_at   IS DISTINCT FROM OLD.issued_at
  ) THEN
    RAISE EXCEPTION 'Invoice % is issued and immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoices_immutable BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION guard_issued_invoice();

CREATE FUNCTION guard_issued_invoice_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv_status invoice_status;
BEGIN
  SELECT status INTO inv_status FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF inv_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Items of an issued invoice cannot be modified' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_invoice_items_immutable BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION guard_issued_invoice_items();

-- -----------------------------------------------------------------------------
-- outbox_events — Transactional Outbox (temps réel, rappels J-1 / H-2)
-- -----------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text        NOT NULL CONSTRAINT ck_outbox_aggregate CHECK (aggregate_type ~ '^[a-z_]{1,64}$'),
  aggregate_id   uuid        NOT NULL,
  event_type     text        NOT NULL CONSTRAINT ck_outbox_event_type CHECK (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  payload        jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);
CREATE INDEX ix_outbox_unpublished ON outbox_events (id) WHERE published_at IS NULL;
