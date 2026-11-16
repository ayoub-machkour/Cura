/**
 * Règles d'autorisation de la réservation (qui peut réserver pour qui), sans base de données.
 */
import { describe, expect, it } from 'vitest';
import { BusinessRuleError, ForbiddenError } from '../../src/common/errors';
import { BookingService } from '../../src/modules/booking/booking.service';

const service = new BookingService({} as ConstructorParameters<typeof BookingService>[0]);
const ids = {
  me: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  slot: '33333333-3333-4333-8333-333333333333',
  type: '44444444-4444-4444-8444-444444444444',
  key: '55555555-5555-4555-8555-555555555555',
  user: '66666666-6666-4666-8666-666666666666',
};
const body = { slotId: ids.slot, appointmentTypeId: ids.type, idempotencyKey: ids.key };

describe('BookingService.commandFor', () => {
  it('un patient réserve pour lui-même, source mobile', () => {
    const cmd = service.commandFor({ sub: ids.user, role: 'patient', pid: ids.me, did: null }, body);
    expect(cmd).toMatchObject({ patientId: ids.me, source: 'mobile' });
  });

  it('un patient ne peut pas réserver pour quelqu’un d’autre', () => {
    expect(() => service.commandFor({ sub: ids.user, role: 'patient', pid: ids.me, did: null }, { ...body, patientId: ids.other })).toThrow(
      ForbiddenError,
    );
  });

  it('le secrétariat doit préciser le patient, source desk', () => {
    const secretary = { sub: ids.user, role: 'secretary' as const, pid: null, did: null };
    expect(() => service.commandFor(secretary, body)).toThrow(BusinessRuleError);
    expect(service.commandFor(secretary, { ...body, patientId: ids.other })).toMatchObject({ patientId: ids.other, source: 'desk' });
  });
});
