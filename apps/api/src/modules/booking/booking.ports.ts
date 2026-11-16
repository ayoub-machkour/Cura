/**
 * Port de pré-réservation : le service en dépend sans connaître Redis (Dependency Inversion).
 * Couche UX uniquement — la garantie d'unicité reste dans PostgreSQL.
 */
export interface SlotHold {
  ownerId: string;
  token: string;
  expiresAt: Date;
}

export interface SlotHoldStore {
  acquire(slotId: string, ownerId: string, ttlMs: number): Promise<SlotHold | null>;
  getHolder(slotId: string): Promise<SlotHold | null>;
  release(slotId: string, ownerId: string, token: string): Promise<void>;
  /** Parmi `slotIds`, ceux tenus par quelqu'un d'autre que `ownerId`. */
  heldByOthers(slotIds: readonly string[], ownerId: string): Promise<Set<string>>;
}
