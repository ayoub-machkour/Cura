/**
 * SOURCE UNIQUE DES RÈGLES DE VALIDATION.
 *
 * Chaque règle existe deux fois, volontairement :
 *  - ici, consommée par les schémas Zod (API, app cabinet, app mobile) ;
 *  - dans les migrations SQL (CHECK constraints), dernier rempart côté base.
 *
 * Toute modification ici DOIT être répercutée dans une nouvelle migration.
 * Le test `apps/api/test/integration/db-constraints.contract.test.ts` vérifie
 * que la base rejette exactement ce que Zod rejette.
 */

export const LIMITS = {
  personName: { min: 1, max: 100 },
  email: { max: 254 },
  password: { min: 12, max: 128 },
  nationalId: { min: 4, max: 32 },
  registrationNumber: { min: 3, max: 32 },
  specialty: { min: 2, max: 100 },
  appointmentTypeLabel: { min: 1, max: 120 },
  appointmentDurationMinutes: { min: 5, max: 240, step: 5 },
  slotDurationMinutes: { min: 5, max: 240 },
  priceCents: { min: 0, max: 100_000_000 },
  note: { max: 500 },
  cancelReason: { max: 300 },
  timezone: { max: 64 },
  birthDateMin: '1900-01-01',
  slotGenerationMaxDays: 92,
  pagination: { defaultLimit: 20, maxLimit: 100 },
  searchQuery: { min: 2, max: 100 },
} as const;

/**
 * Expressions régulières : la forme JS (Zod) et la forme PostgreSQL (CHECK) sont
 * côte à côte pour rester synchronisées.
 */
export const PATTERNS = {
  /** E.164 : +[indicatif][numéro], 7 à 15 chiffres. */
  phoneE164: {
    js: /^\+[1-9][0-9]{6,14}$/,
    sql: String.raw`^\+[1-9][0-9]{6,14}$`,
  },
  /** Nom de personne : pas de chiffre, pas de chevron, pas de caractère de contrôle. */
  personName: {
    js: /^[^0-9<>\p{Cc}]+$/u,
    sql: '^[^0-9<>[:cntrl:]]+$',
  },
  /** Anti-XSS pour le texte libre : refuse tout ce qui ressemble à une balise HTML (`<a`, `</`, `<!`, `<?`), mais accepte « tension < 12 ». */
  noHtmlTag: {
    js: /<[a-zA-Z/!?]/,
    sql: '<[a-zA-Z/!?]',
  },
  email: {
    js: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
    sql: String.raw`^[^@\s]+@[^@\s]+\.[^@\s]+$`,
  },
  nationalId: {
    js: /^[A-Za-z0-9-]+$/,
    sql: '^[A-Za-z0-9-]+$',
  },
  registrationNumber: {
    js: /^[A-Za-z0-9/-]+$/,
    sql: '^[A-Za-z0-9/-]+$',
  },
  appointmentTypeCode: {
    js: /^[A-Z0-9_]{2,32}$/,
    sql: '^[A-Z0-9_]{2,32}$',
  },
  hexColor: {
    js: /^#[0-9A-Fa-f]{6}$/,
    sql: '^#[0-9A-Fa-f]{6}$',
  },
  currency: {
    js: /^[A-Z]{3}$/,
    sql: '^[A-Z]{3}$',
  },
  /** Heure locale HH:MM (génération de créneaux). */
  localTime: {
    js: /^([01][0-9]|2[0-3]):[0-5][0-9]$/,
    sql: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
  },
} as const;

export const USER_ROLES = ['admin', 'doctor', 'secretary', 'patient'] as const;
export type Role = (typeof USER_ROLES)[number];
export const STAFF_ROLES = ['admin', 'doctor', 'secretary'] as const satisfies readonly Role[];

export const APPOINTMENT_STATUSES = [
  'scheduled', 'confirmed', 'checked_in', 'in_consultation', 'completed', 'cancelled', 'no_show',
] as const;
export type AppointmentStatusValue = (typeof APPOINTMENT_STATUSES)[number];

export const BOOKING_SOURCES = ['mobile', 'desk', 'phone'] as const;
export const SEXES = ['F', 'M', 'X'] as const;
