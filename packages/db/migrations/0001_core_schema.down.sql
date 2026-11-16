DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS invoice_items;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS invoice_counters;
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS slots;
DROP TABLE IF EXISTS appointment_types;
DROP TABLE IF EXISTS patients;
DROP TABLE IF EXISTS doctors;

DROP FUNCTION IF EXISTS guard_issued_invoice_items();
DROP FUNCTION IF EXISTS guard_issued_invoice();
DROP FUNCTION IF EXISTS set_updated_at();

DROP DOMAIN IF EXISTS money_cents;
DROP DOMAIN IF EXISTS hex_color;
DROP DOMAIN IF EXISTS safe_text;
DROP DOMAIN IF EXISTS email_address;
DROP DOMAIN IF EXISTS phone_e164;
DROP DOMAIN IF EXISTS person_name;

DROP TYPE IF EXISTS payment_method;
DROP TYPE IF EXISTS invoice_status;
DROP TYPE IF EXISTS booking_source;
DROP TYPE IF EXISTS appointment_status;
DROP TYPE IF EXISTS slot_status;
-- Les extensions sont conservées (partagées, sans effet de bord).
