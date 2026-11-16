/**
 * Hachage de mots de passe avec scrypt (natif Node, sans dépendance compilée :
 * image Docker plus simple et plus sûre). Paramètres OWASP : N=2^15, r=8, p=1.
 *
 * Format stocké : scrypt$N$r$p$<salt base64url>$<hash base64url>
 * Les paramètres sont stockés avec le hash : on peut les durcir plus tard sans
 * invalider les mots de passe existants (`needsRehash`).
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
  needsRehash(stored: string): boolean;
}

export class ScryptPasswordHasher implements PasswordHasher {
  constructor(private readonly params: ScryptParams = DEFAULT_SCRYPT_PARAMS) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await this.derive(password, salt, this.params);
    const { N, r, p } = this.params;
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;
    const key = await this.derive(password, parsed.salt, parsed.params);
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  }

  needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    return !parsed || parsed.params.N < this.params.N || parsed.params.r < this.params.r || parsed.params.p < this.params.p;
  }

  private derive(password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
    // maxmem doit couvrir 128 * N * r octets.
    return scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r });
  }
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  return { params: { N, r, p }, salt: Buffer.from(parts[4]!, 'base64url'), key: Buffer.from(parts[5]!, 'base64url') };
}
