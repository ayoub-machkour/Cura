-- =============================================================================
-- 0002 — Authentification : comptes, rôles (RBAC), refresh tokens
-- Montre aussi l'ajout de contraintes sur des tables existantes.
-- =============================================================================

CREATE TYPE user_role AS ENUM ('admin', 'doctor', 'secretary', 'patient');

CREATE TABLE users (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 email_address NOT NULL,
  -- Format produit par ScryptPasswordHasher : scrypt$N$r$p$salt$hash
  password_hash         text          NOT NULL CONSTRAINT ck_users_password_hash CHECK (
                                        password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
                                      ),
  role                  user_role     NOT NULL,
  patient_id            uuid          REFERENCES patients (id) ON DELETE RESTRICT,
  doctor_id             uuid          REFERENCES doctors (id) ON DELETE RESTRICT,
  is_active             boolean       NOT NULL DEFAULT true,
  failed_login_attempts integer       NOT NULL DEFAULT 0 CONSTRAINT ck_users_failed_attempts CHECK (failed_login_attempts >= 0),
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT uq_users_email   UNIQUE (email),
  CONSTRAINT uq_users_patient UNIQUE (patient_id),
  CONSTRAINT uq_users_doctor  UNIQUE (doctor_id),
  -- Le rôle détermine EXACTEMENT les liens autorisés.
  CONSTRAINT ck_users_role_links CHECK (
       (role = 'patient' AND patient_id IS NOT NULL AND doctor_id IS NULL)
    OR (role = 'doctor'  AND doctor_id  IS NOT NULL AND patient_id IS NULL)
    OR (role IN ('admin', 'secretary') AND patient_id IS NULL AND doctor_id IS NULL)
  )
);
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Refresh tokens opaques, stockés HACHÉS (SHA-256) : une fuite de la base ne
-- permet pas de les rejouer. Rotation à chaque usage ; la réutilisation d'un
-- jeton déjà tourné révoque toute la famille (détection de vol).
CREATE TABLE refresh_tokens (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id      uuid        NOT NULL,
  token_hash     char(64)    NOT NULL CONSTRAINT ck_refresh_tokens_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text        CONSTRAINT ck_refresh_tokens_reason CHECK (
                               revoked_reason IN ('rotated', 'logout', 'reuse_detected', 'password_change', 'admin')
                             ),
  replaced_by    uuid        REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  user_agent     text        CONSTRAINT ck_refresh_tokens_ua CHECK (char_length(user_agent) <= 512),
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_refresh_tokens_hash UNIQUE (token_hash),
  CONSTRAINT ck_refresh_tokens_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_refresh_tokens_revocation CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX ix_refresh_tokens_user          ON refresh_tokens (user_id);
CREATE INDEX ix_refresh_tokens_family_active ON refresh_tokens (family_id) WHERE revoked_at IS NULL;
CREATE INDEX ix_refresh_tokens_expiry        ON refresh_tokens (expires_at); -- purge périodique

-- Traçabilité : les colonnes "auteur" de la facturation référencent désormais users.
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_created_by
  FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE payments ADD CONSTRAINT fk_payments_received_by
  FOREIGN KEY (received_by) REFERENCES users (id) ON DELETE RESTRICT;
