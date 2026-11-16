-- =============================================================================
-- 0001_init.sql — Schéma initial du cabinet médical
-- PostgreSQL >= 14
--
-- Principe directeur : la base de données est l'ULTIME garde-fou.
-- Même si le code applicatif avait un bug, les contraintes ci-dessous rendent
-- physiquement impossible : une double réservation d'un créneau, deux RDV qui
-- se chevauchent pour un même médecin, ou un patient à deux endroits à la fois.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- EXCLUDE combinant égalité (uuid) + chevauchement (tstzrange)
CREATE EXTENSION IF NOT EXISTS citext;      -- emails insensibles à la casse
-- gen_random_uuid() est natif depuis PostgreSQL 13.

-- -----------------------------------------------------------------------------
-- Types énumérés
-- -----------------------------------------------------------------------------
CREATE TYPE slot_status        AS ENUM ('open', 'blocked');
CREATE TYPE appointment_status AS ENUM (
  'scheduled',        -- réservé
  'confirmed',        -- confirmé par le patient (rappel J-1 / H-2)
  'checked_in',       -- arrivé au cabinet → file d'attente
  'in_consultation',  -- en consultation
  'completed',        -- terminé
  'cancelled',        -- annulé (libère le créneau)
  'no_show'           -- absent
);
CREATE TYPE booking_source     AS ENUM ('mobile', 'desk', 'phone');
CREATE TYPE invoice_status     AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'void');
CREATE TYPE payment_method     AS ENUM ('cash', 'card', 'check', 'transfer', 'insurance');

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
  first_name          text        NOT NULL CHECK (btrim(first_name) <> ''),
  last_name           text        NOT NULL CHECK (btrim(last_name)  <> ''),
  specialty           text        NOT NULL,
  registration_number text        NOT NULL UNIQUE,            -- n° d'inscription à l'Ordre
  timezone            text        NOT NULL DEFAULT 'UTC',     -- IANA, ex. 'Africa/Casablanca'
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_doctors_updated_at BEFORE UPDATE ON doctors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- patients
-- NB : pas d'UNIQUE sur le téléphone / l'email — un parent gère souvent le
-- dossier de ses enfants avec le même numéro. L'unicité forte porte sur
-- l'identifiant national (quand il est connu) et sur le compte mobile.
-- -----------------------------------------------------------------------------
CREATE TABLE patients (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    text        NOT NULL CHECK (btrim(first_name) <> ''),
  last_name     text        NOT NULL CHECK (btrim(last_name)  <> ''),
  birth_date    date        NOT NULL CHECK (birth_date > DATE '1900-01-01'),
  sex           char(1)     CHECK (sex IN ('F', 'M', 'X')),
  phone_e164    text        NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email         citext,
  national_id   text,
  auth_user_id  uuid        UNIQUE,                 -- lien vers le compte de l'app mobile
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz                         -- soft delete (obligation de conservation)
);
CREATE UNIQUE INDEX uq_patients_national_id
  ON patients (national_id) WHERE national_id IS NOT NULL AND deleted_at IS NULL;
-- Recherche rapide au secrétariat + détection de doublons.
CREATE INDEX ix_patients_identity ON patients (lower(last_name), lower(first_name), birth_date);
CREATE INDEX ix_patients_phone    ON patients (phone_e164);
CREATE TRIGGER trg_patients_updated_at BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- appointment_types (motifs) — porte la couleur de l'agenda et la durée
-- -----------------------------------------------------------------------------
CREATE TABLE appointment_types (
  id                  uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text    NOT NULL UNIQUE,
  label               text    NOT NULL,
  duration_minutes    integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 240),
  color_hex           text    NOT NULL CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  bookable_online     boolean NOT NULL DEFAULT true,
  default_price_cents bigint  NOT NULL DEFAULT 0 CHECK (default_price_cents >= 0),
  is_active           boolean NOT NULL DEFAULT true
);

-- -----------------------------------------------------------------------------
-- slots — créneaux générés à partir du planning du médecin
--
-- Le statut "réservé" n'est PAS stocké ici : il est dérivé de l'existence d'un
-- RDV actif. Une seule source de vérité ⇒ aucune désynchronisation possible
-- (annuler un RDV libère automatiquement le créneau).
-- -----------------------------------------------------------------------------
CREATE TABLE slots (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       uuid        NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  status          slot_status NOT NULL DEFAULT 'open',
  online_bookable boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_slots_range CHECK (ends_at > starts_at),
  CONSTRAINT uq_slots_doctor_start UNIQUE (doctor_id, starts_at),
  -- Cible de la FK composite depuis appointments (garantit la cohérence horaire).
  CONSTRAINT uq_slots_identity UNIQUE (id, doctor_id, starts_at, ends_at),
  -- Deux créneaux d'un même médecin ne peuvent jamais se chevaucher.
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
  appointment_type_id uuid               NOT NULL REFERENCES appointment_types (id),
  slot_id             uuid,              -- NULL pour un patient sans RDV (walk-in)
  starts_at           timestamptz        NOT NULL,
  ends_at             timestamptz        NOT NULL,
  status              appointment_status NOT NULL DEFAULT 'scheduled',
  source              booking_source     NOT NULL,
  idempotency_key     uuid               NOT NULL,
  note                text               CHECK (length(note) <= 500),
  confirmed_at        timestamptz,
  checked_in_at       timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text,
  version             integer            NOT NULL DEFAULT 1,   -- verrou optimiste (édition agenda)
  created_at          timestamptz        NOT NULL DEFAULT now(),
  updated_at          timestamptz        NOT NULL DEFAULT now(),

  CONSTRAINT ck_appointments_range CHECK (ends_at > starts_at),
  CONSTRAINT ck_appointments_cancel CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),

  -- Le RDV hérite EXACTEMENT du médecin et des horaires de son créneau
  -- (MATCH SIMPLE : contrôle ignoré si slot_id est NULL → walk-in).
  CONSTRAINT fk_appointments_slot FOREIGN KEY (slot_id, doctor_id, starts_at, ends_at)
    REFERENCES slots (id, doctor_id, starts_at, ends_at) ON DELETE RESTRICT,

  -- Rejeu sûr des requêtes mobiles (réseau instable, double tap).
  CONSTRAINT uq_appointments_idempotency UNIQUE (patient_id, idempotency_key),

  -- GARDE-FOU N°1 : un médecin ne peut pas avoir deux RDV actifs qui se chevauchent,
  -- qu'ils viennent d'un créneau, du secrétariat ou d'un walk-in.
  CONSTRAINT ex_appointments_doctor_overlap EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled', 'no_show')),

  -- GARDE-FOU N°2 : un patient ne peut pas être à deux RDV en même temps.
  CONSTRAINT ex_appointments_patient_overlap EXCLUDE USING gist (
    patient_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled', 'no_show'))
);

-- GARDE-FOU N°3 (explicite et peu coûteux) : un seul RDV actif par créneau.
CREATE UNIQUE INDEX uq_appointments_active_slot
  ON appointments (slot_id)
  WHERE slot_id IS NOT NULL AND status NOT IN ('cancelled', 'no_show');

CREATE INDEX ix_appointments_doctor_day ON appointments (doctor_id, starts_at);
CREATE INDEX ix_appointments_patient    ON appointments (patient_id, starts_at DESC);
-- File d'attente live : index minuscule, ne contient que les patients présents.
CREATE INDEX ix_appointments_queue
  ON appointments (doctor_id, checked_in_at)
  WHERE status IN ('checked_in', 'in_consultation');

CREATE TRIGGER trg_appointments_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- invoices / invoice_items / payments
-- Montants en centimes (bigint) : jamais de float pour de l'argent.
-- -----------------------------------------------------------------------------

-- Numérotation séquentielle SANS TROU, exigée légalement pour les factures.
-- (Une SEQUENCE Postgres peut créer des trous en cas de rollback.)
CREATE TABLE invoice_counters (
  year       integer PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0 CHECK (last_value >= 0)
);

CREATE TABLE invoices (
  id             uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text           UNIQUE,                     -- ex. '2026-000123', attribué à l'émission
  patient_id     uuid           NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  appointment_id uuid           UNIQUE REFERENCES appointments (id) ON DELETE RESTRICT,
  status         invoice_status NOT NULL DEFAULT 'draft',
  currency       char(3)        NOT NULL,
  total_cents    bigint         NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  paid_cents     bigint         NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  issued_at      timestamptz,
  created_by     uuid,                                       -- utilisateur du secrétariat
  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT ck_invoices_issued CHECK (
    status = 'draft' OR (number IS NOT NULL AND issued_at IS NOT NULL)
  ),
  CONSTRAINT ck_invoices_paid CHECK (paid_cents <= total_cents)
);
CREATE INDEX ix_invoices_issued_day ON invoices (issued_at) WHERE status <> 'draft'; -- récap journalier
CREATE INDEX ix_invoices_patient    ON invoices (patient_id, created_at DESC);
CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_items (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid    NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  act_code         text    NOT NULL,                        -- nomenclature des actes
  label            text    NOT NULL,
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint  NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents bigint  GENERATED ALWAYS AS (quantity * unit_price_cents) STORED
);
CREATE INDEX ix_invoice_items_invoice ON invoice_items (invoice_id);

CREATE TABLE payments (
  id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid           NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  amount_cents bigint         NOT NULL CHECK (amount_cents > 0),
  method       payment_method NOT NULL,
  paid_at      timestamptz    NOT NULL DEFAULT now(),
  received_by  uuid
);
CREATE INDEX ix_payments_day ON payments (paid_at); -- clôture de caisse

-- Une facture émise est IMMUABLE : seules les transitions de paiement/annulation
-- sont autorisées. Toute correction passe par un avoir (nouvelle facture).
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
-- outbox_events — Transactional Outbox
-- L'événement est écrit DANS la même transaction que le RDV. Un relais le
-- publie ensuite (Socket.io → agenda/file d'attente live, BullMQ → rappels
-- J-1/H-2). Aucun événement fantôme si la transaction échoue, aucun perdu
-- si elle réussit.
-- -----------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text        NOT NULL,
  aggregate_id   uuid        NOT NULL,
  event_type     text        NOT NULL,
  payload        jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);
CREATE INDEX ix_outbox_unpublished ON outbox_events (id) WHERE published_at IS NULL;

COMMIT;
