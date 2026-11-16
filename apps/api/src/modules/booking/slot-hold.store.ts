/**
 * Pré-réservation de créneau via Redis (verrou à durée de vie limitée).
 *
 * Valeur stockée : "<ownerId>|<token>"  —  clé : "slot-hold:<slotId>"
 * Les opérations "lire puis écrire" passent par des scripts Lua, exécutés
 * atomiquement par Redis : pas de fenêtre de course entre GET et SET/DEL.
 */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SlotHold, SlotHoldStore } from './booking.ports';

const key = (slotId: string) => `slot-hold:${slotId}`;
const SEP = '|';

/**
 * Pose le verrou s'il est libre. S'il appartient déjà au même patient, on prolonge
 * son TTL et on renvoie le jeton existant (re-sélection idempotente).
 * Retour : la valeur détenue, ou false si un autre patient le tient.
 */
const ACQUIRE_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return ARGV[1]
end
if string.sub(current, 1, string.len(ARGV[3]) + 1) == ARGV[3] .. '${SEP}' then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return current
end
return false
`;

/** Ne supprime que si le verrou appartient toujours à l'appelant (compare-and-delete). */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function parse(value: string, ttlMs: number, now: number): SlotHold | null {
  const idx = value.indexOf(SEP);
  if (idx <= 0) return null;
  return {
    ownerId: value.slice(0, idx),
    token: value.slice(idx + 1),
    expiresAt: new Date(now + Math.max(ttlMs, 0)),
  };
}

export class RedisSlotHoldStore implements SlotHoldStore {
  constructor(private readonly redis: Redis) {}

  async acquire(slotId: string, ownerId: string, ttlMs: number): Promise<SlotHold | null> {
    const candidate = `${ownerId}${SEP}${randomBytes(24).toString('base64url')}`;
    const result = (await this.redis.eval(ACQUIRE_LUA, 1, key(slotId), candidate, String(ttlMs), ownerId)) as
      | string
      | null;
    return result ? parse(result, ttlMs, Date.now()) : null;
  }

  async getHolder(slotId: string): Promise<SlotHold | null> {
    const [[, value], [, pttl]] = (await this.redis
      .multi()
      .get(key(slotId))
      .pttl(key(slotId))
      .exec()) as [[null, string | null], [null, number]];
    return value ? parse(value, pttl, Date.now()) : null;
  }

  async release(slotId: string, ownerId: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, key(slotId), `${ownerId}${SEP}${token}`);
  }

  async heldByOthers(slotIds: readonly string[], ownerId: string): Promise<Set<string>> {
    if (slotIds.length === 0) return new Set();
    const values = await this.redis.mget(...slotIds.map(key));
    const held = new Set<string>();
    values.forEach((value, i) => {
      const slotId = slotIds[i];
      if (value && slotId && !value.startsWith(`${ownerId}${SEP}`)) held.add(slotId);
    });
    return held;
  }
}
