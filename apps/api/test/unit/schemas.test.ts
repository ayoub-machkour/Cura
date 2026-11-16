/**
 * Règles de validation partagées (packages/shared) : ce que l'API, l'app cabinet
 * et l'app mobile accepteront ou refuseront.
 */
import { describe, expect, it } from 'vitest';
import {
  BookAppointmentRequest,
  CreateAppointmentTypeRequest,
  CreatePatientRequest,
  CreateStaffUserRequest,
  GenerateSlotsRequest,
  ListPatientsQuery,
  PersonName,
  PhoneE164,
  safeText,
} from '@cura/shared';

const uuid = '3f1c2a6e-8b4d-4c1a-9e2f-1a2b3c4d5e6f';

describe('PersonName', () => {
  it.each(['Ayoub', 'El Amrani', "O'Connor", 'Jean-Pierre', 'Zoë', 'محمد'])('accepte « %s »', (name) => {
    expect(PersonName.safeParse(name).success).toBe(true);
  });

  it('supprime les espaces superflus', () => {
    expect(PersonName.parse('  Ayoub  ')).toBe('Ayoub');
  });

  it.each(['', '   ', 'R2D2', '<script>', 'a'.repeat(101), 'Bad\u0007Name'])('rejette « %s »', (name) => {
    expect(PersonName.safeParse(name).success).toBe(false);
  });
});

describe('PhoneE164', () => {
  it.each(['+212600000000', '+33612345678'])('accepte %s', (p) => expect(PhoneE164.safeParse(p).success).toBe(true));
  it.each(['0600000000', '+0123456789', '+1234', '+21260000000000000'])('rejette %s', (p) =>
    expect(PhoneE164.safeParse(p).success).toBe(false),
  );
});

describe('safeText (anti-XSS)', () => {
  const note = safeText(500);
  it.each(['Tension < 12, à surveiller', 'a > b', 'Douleur 3/10'])('accepte « %s »', (t) => {
    expect(note.safeParse(t).success).toBe(true);
  });
  it.each(['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '</div>', '<!-- x -->', '<svg/onload=alert(1)>'])(
    'rejette « %s »',
    (t) => expect(note.safeParse(t).success).toBe(false),
  );
});

describe('CreatePatientRequest', () => {
  const base = { firstName: 'Ayoub', lastName: 'Test', birthDate: '1990-05-01', phone: '+212600000000' };
  it('accepte un patient minimal et normalise l’email', () => {
    expect(CreatePatientRequest.parse({ ...base, email: ' Ayoub@Example.COM ' }).email).toBe('ayoub@example.com');
  });
  it('rejette une date de naissance future ou trop ancienne', () => {
    expect(CreatePatientRequest.safeParse({ ...base, birthDate: '2999-01-01' }).success).toBe(false);
    expect(CreatePatientRequest.safeParse({ ...base, birthDate: '1899-12-31' }).success).toBe(false);
  });
});

describe('CreateStaffUserRequest', () => {
  const base = { email: 'doc@cura.test', password: 'a-very-long-password' };
  it('exige doctorId pour un médecin, l’interdit pour les autres rôles', () => {
    expect(CreateStaffUserRequest.safeParse({ ...base, role: 'doctor' }).success).toBe(false);
    expect(CreateStaffUserRequest.safeParse({ ...base, role: 'doctor', doctorId: uuid }).success).toBe(true);
    expect(CreateStaffUserRequest.safeParse({ ...base, role: 'secretary', doctorId: uuid }).success).toBe(false);
  });
  it('impose 12 caractères minimum', () => {
    expect(CreateStaffUserRequest.safeParse({ ...base, password: 'short', role: 'admin' }).success).toBe(false);
  });
});

describe('CreateAppointmentTypeRequest', () => {
  const base = { code: 'consult', label: 'Consultation', durationMinutes: 20, colorHex: '#2563EB' };
  it('met le code en majuscules et applique les valeurs par défaut', () => {
    expect(CreateAppointmentTypeRequest.parse(base)).toMatchObject({ code: 'CONSULT', bookableOnline: true, defaultPriceCents: 0 });
  });
  it('rejette une durée non multiple de 5', () => {
    expect(CreateAppointmentTypeRequest.safeParse({ ...base, durationMinutes: 22 }).success).toBe(false);
  });
});

describe('GenerateSlotsRequest', () => {
  const base = { from: '2026-12-01', to: '2026-12-07', weekdays: [1, 2, 3, 4, 5], dayStart: '08:00', dayEnd: '12:00', slotMinutes: 20 };
  it('accepte une semaine type', () => expect(GenerateSlotsRequest.safeParse(base).success).toBe(true));
  it('rejette une période inversée', () => expect(GenerateSlotsRequest.safeParse({ ...base, from: '2026-12-08' }).success).toBe(false));
  it('rejette une période > 92 jours', () => expect(GenerateSlotsRequest.safeParse({ ...base, to: '2027-06-01' }).success).toBe(false));
  it('rejette une plage plus courte qu’un créneau', () =>
    expect(GenerateSlotsRequest.safeParse({ ...base, dayEnd: '08:10' }).success).toBe(false));
  it('rejette une heure invalide', () => expect(GenerateSlotsRequest.safeParse({ ...base, dayStart: '25:00' }).success).toBe(false));
});

describe('BookAppointmentRequest', () => {
  it('exige une clé d’idempotence UUID', () => {
    expect(BookAppointmentRequest.safeParse({ slotId: uuid, appointmentTypeId: uuid }).success).toBe(false);
    expect(BookAppointmentRequest.safeParse({ slotId: uuid, appointmentTypeId: uuid, idempotencyKey: uuid }).success).toBe(true);
  });
});

describe('ListPatientsQuery (pagination)', () => {
  it('convertit et borne `limit`', () => {
    expect(ListPatientsQuery.parse({}).limit).toBe(20);
    expect(ListPatientsQuery.parse({ limit: '50' }).limit).toBe(50);
    expect(ListPatientsQuery.safeParse({ limit: '1000' }).success).toBe(false);
    expect(ListPatientsQuery.safeParse({ limit: '0' }).success).toBe(false);
  });
});
