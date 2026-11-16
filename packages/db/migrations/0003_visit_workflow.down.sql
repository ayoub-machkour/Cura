DROP INDEX IF EXISTS ix_outbox_published;
DROP TABLE IF EXISTS appointment_status_changes;
DROP FUNCTION IF EXISTS forbid_status_change_mutation();
DROP INDEX IF EXISTS uq_appointments_one_consultation_per_doctor;
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS ck_appointments_chronology,
  DROP CONSTRAINT IF EXISTS ck_appointments_no_show,
  DROP CONSTRAINT IF EXISTS ck_appointments_completed,
  DROP CONSTRAINT IF EXISTS ck_appointments_consultation,
  DROP COLUMN IF EXISTS no_show_at,
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS consultation_started_at;
