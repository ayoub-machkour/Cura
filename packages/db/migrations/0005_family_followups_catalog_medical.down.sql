DROP TABLE IF EXISTS patient_medical_profile_changes;
DROP FUNCTION IF EXISTS forbid_mutation();
DROP TABLE IF EXISTS patient_medical_profiles;
DROP FUNCTION IF EXISTS is_clean_text_list(text[], integer, integer);
DROP TYPE IF EXISTS blood_type;

-- Échoue s'il existe deux soins de médecins différents avec le même code : voulu (aucune perte silencieuse).
DROP INDEX IF EXISTS ix_appointment_types_doctor;
ALTER TABLE appointment_types DROP CONSTRAINT uq_appointment_types_code;
ALTER TABLE appointment_types ADD CONSTRAINT uq_appointment_types_code UNIQUE (code);
ALTER TABLE appointment_types DROP COLUMN IF EXISTS doctor_id;

DROP INDEX IF EXISTS ix_appointments_follow_up;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS ck_appointments_follow_up_not_self;
ALTER TABLE appointments DROP COLUMN IF EXISTS follow_up_of;

DROP TABLE IF EXISTS patient_guardians;
DROP TYPE IF EXISTS family_relationship;
