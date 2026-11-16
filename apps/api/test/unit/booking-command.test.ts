/**
 * Règles « qui peut réserver pour qui », sans base de données (accès famille simulé).
 */
import { describe, expect, it } from 'vitest';
import { BusinessRuleError, ForbiddenError } from '../../src/common/errors';
import { BookingService } from '../../src/modules/booking/booking.service';

const ids = {
  me: '11111111-1111-4111-8111-111111111111',
  child: '22222222-2222-4222-8222-222222222222',
  stranger: '77777777-7777-4777-8777-777777777777',
  slot: '33333333-3333-4333-8333-333333333333',
  type: '44444444-4444-4444-8444-444444444444',
  key: '55555555-5555-4555-8555-555555555555',
  user: '66666666-6666-4666-8666-666666666666',
  visit: '88888888-8888-4888-8888-888888888888',
};

// Accès simulé : le patient gère son dossier et celui de son enfant.
const access = {
  canAccessPatient: async (_p: unknown, patientId: string) => patientId === ids.me || patientId === ids.child,
};
const service = new BookingService({ access } as unknown as ConstructorParameters<typeof BookingService>[0]);
const body = { slotId: ids.slot, appointmentTypeId: ids.type, idempotencyKey: ids.key };
const patient = { sub: ids.user, role: 'patient' as const, pid: ids.me, did: null };
const secretary = { sub: ids.user, role: 'secretary' as const, pid: null, did: null };

describe('BookingService.prepare', () => {
  it('un patient réserve pour lui-même par défaut, source mobile', async () => {
    expect(await service.prepare(patient, body)).toMatchObject({ patientId: ids.me, source: 'mobile', actorUserId: ids.user });
  });

  it('un parent réserve pour son enfant rattaché', async () => {
    expect(await service.prepare(patient, { ...body, patientId: ids.child })).toMatchObject({ patientId: ids.child, source: 'mobile' });
  });

  it('un patient ne peut pas réserver pour une personne non rattachée', async () => {
    await expect(service.prepare(patient, { ...body, patientId: ids.stranger })).rejects.toThrow(ForbiddenError);
  });

  it('un patient ne peut pas fixer lui-même un RDV de contrôle', async () => {
    await expect(service.prepare(patient, { ...body, followUpOfId: ids.visit })).rejects.toThrow(ForbiddenError);
  });

  it('le secrétariat doit préciser le patient ; il peut fixer un contrôle (source desk)', async () => {
    await expect(service.prepare(secretary, body)).rejects.toThrow(BusinessRuleError);
    expect(await service.prepare(secretary, { ...body, patientId: ids.stranger, followUpOfId: ids.visit })).toMatchObject({
      patientId: ids.stranger,
      source: 'desk',
      followUpOfId: ids.visit,
    });
  });
});
