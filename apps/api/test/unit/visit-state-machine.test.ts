import { describe, expect, it } from 'vitest';
import { APPOINTMENT_STATUSES, type AppointmentStatus } from '@cura/shared';
import { checkTransition, TRANSITIONS, VISIT_ACTIONS, type VisitAction } from '../../src/modules/visits/visit-state-machine';

const now = new Date('2030-01-15T10:00:00Z');
const ctx = (status: AppointmentStatus, over: Partial<Parameters<typeof checkTransition>[1]> = {}) => ({
  status,
  startsAt: new Date('2030-01-15T10:00:00Z'),
  appointmentDay: '2030-01-15',
  today: '2030-01-15',
  now,
  ...over,
});

/** Matrice attendue : action → statuts de départ autorisés. */
const EXPECTED: Record<VisitAction, AppointmentStatus[]> = {
  confirm: ['scheduled'],
  check_in: ['scheduled', 'confirmed'],
  start: ['checked_in'],
  complete: ['in_consultation'],
  no_show: ['scheduled', 'confirmed'],
};

describe('machine à états du parcours de visite', () => {
  // Matrice complète : 5 actions × 7 statuts = 35 cas.
  for (const action of VISIT_ACTIONS) {
    for (const status of APPOINTMENT_STATUSES) {
      const allowed = EXPECTED[action].includes(status);
      it(`${action} depuis « ${status} » → ${allowed ? 'autorisé' : 'INVALID_TRANSITION'}`, () => {
        // confirm exige un RDV futur : on décale le RDV d'une heure pour isoler la règle de statut.
        const context = ctx(status, action === 'confirm' ? { startsAt: new Date(now.getTime() + 3_600_000) } : {});
        const result = checkTransition(action, context);
        if (allowed) expect(result).toBeNull();
        else expect(result?.code).toBe('INVALID_TRANSITION');
      });
    }
  }

  it('les statuts terminaux n’ont aucune sortie', () => {
    for (const terminal of ['completed', 'cancelled', 'no_show'] as const) {
      for (const action of VISIT_ACTIONS) expect(checkTransition(action, ctx(terminal))?.code).toBe('INVALID_TRANSITION');
    }
  });

  it('chaque action mène au statut attendu', () => {
    expect(Object.fromEntries(VISIT_ACTIONS.map((a) => [a, TRANSITIONS[a].to]))).toEqual({
      confirm: 'confirmed',
      check_in: 'checked_in',
      start: 'in_consultation',
      complete: 'completed',
      no_show: 'no_show',
    });
  });

  describe('gardes temporelles', () => {
    it('confirm : refusé pour un RDV passé ou en cours', () => {
      expect(checkTransition('confirm', ctx('scheduled'))?.code).toBe('APPOINTMENT_PAST');
      expect(checkTransition('confirm', ctx('scheduled', { startsAt: new Date(now.getTime() + 60_000) }))).toBeNull();
    });

    it('check_in : uniquement le jour du RDV (jour local du médecin)', () => {
      expect(checkTransition('check_in', ctx('scheduled', { appointmentDay: '2030-01-16' }))?.code).toBe('NOT_TODAY');
      expect(checkTransition('check_in', ctx('scheduled', { appointmentDay: '2030-01-14' }))?.code).toBe('NOT_TODAY');
      expect(checkTransition('check_in', ctx('confirmed', { startsAt: new Date(now.getTime() + 7_200_000) }))).toBeNull(); // en avance, même jour
    });

    it('no_show : pas avant l’heure du RDV', () => {
      expect(checkTransition('no_show', ctx('scheduled', { startsAt: new Date(now.getTime() + 60_000) }))?.code).toBe('TOO_EARLY');
      expect(checkTransition('no_show', ctx('scheduled'))).toBeNull(); // à l'heure exacte
    });
  });
});
