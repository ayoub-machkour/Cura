/** Horloge injectable : rend testables les règles dépendant du temps. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
