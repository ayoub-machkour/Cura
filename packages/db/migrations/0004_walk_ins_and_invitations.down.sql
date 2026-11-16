-- Attention : échoue s'il existe des walk-ins actifs qui chevauchent l'agenda
-- (les anciennes contraintes les interdisaient). C'est voulu : aucune perte silencieuse.
DROP TABLE IF EXISTS patient_invitations;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS ck_appointments_walk_in;
DROP INDEX IF EXISTS uq_appointments_patient_in_queue;

ALTER TABLE appointments DROP CONSTRAINT ex_appointments_patient_overlap;
ALTER TABLE appointments ADD CONSTRAINT ex_appointments_patient_overlap EXCLUDE USING gist (
  patient_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status NOT IN ('cancelled', 'no_show'));

ALTER TABLE appointments DROP CONSTRAINT ex_appointments_doctor_overlap;
ALTER TABLE appointments ADD CONSTRAINT ex_appointments_doctor_overlap EXCLUDE USING gist (
  doctor_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status NOT IN ('cancelled', 'no_show'));
