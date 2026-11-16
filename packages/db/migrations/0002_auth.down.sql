ALTER TABLE payments DROP CONSTRAINT IF EXISTS fk_payments_received_by;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS fk_invoices_created_by;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS users;
DROP TYPE IF EXISTS user_role;
