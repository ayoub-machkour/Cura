/**
 * Machine à états du parcours de visite — module PUR (aucune E/S), testable exhaustivement.
 *
 *   scheduled ──confirm──▶ confirmed
 *   scheduled / confirmed ──check_in──▶ checked_in ──start──▶ in_consultation ──complete──▶ completed
 *   scheduled / confirmed ──no_show──▶ no_show
 *
 * L'annulation (scheduled / confirmed → cancelled) est gérée par le module booking.
 */
import type { AppointmentStatus } from '@cura/shared';

export const VISIT_ACTIONS = ['confirm', 'check_in', 'start', 'complete', 'no_show'] as const;
export type VisitAction = (typeof VISIT_ACTIONS)[number];

export interface TransitionRule {
  from: readonly AppointmentStatus[];
  to: AppointmentStatus;
}

export const TRANSITIONS: Readonly<Record<VisitAction, TransitionRule>> = {
  confirm: { from: ['scheduled'], to: 'confirmed' },
  check_in: { from: ['scheduled', 'confirmed'], to: 'checked_in' },
  start: { from: ['checked_in'], to: 'in_consultation' },
  complete: { from: ['in_consultation'], to: 'completed' },
  no_show: { from: ['scheduled', 'confirmed'], to: 'no_show' },
};

export type GuardFailure =
  | { code: 'INVALID_TRANSITION'; message: string }
  | { code: 'APPOINTMENT_PAST'; message: string }
  | { code: 'NOT_TODAY'; message: string }
  | { code: 'TOO_EARLY'; message: string };

export interface TransitionContext {
  status: AppointmentStatus;
  startsAt: Date;
  /** Jour local du RDV et jour local courant, dans le fuseau du médecin (YYYY-MM-DD). */
  appointmentDay: string;
  today: string;
  now: Date;
}

/** Retourne null si la transition est permise, sinon la raison du refus. */
export function checkTransition(action: VisitAction, ctx: TransitionContext): GuardFailure | null {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(ctx.status)) {
    return { code: 'INVALID_TRANSITION', message: `Action « ${action} » impossible depuis le statut « ${ctx.status} »` };
  }
  switch (action) {
    case 'confirm':
      if (ctx.startsAt <= ctx.now) return { code: 'APPOINTMENT_PAST', message: 'Un rendez-vous passé ne peut plus être confirmé' };
      break;
    case 'check_in':
      if (ctx.appointmentDay !== ctx.today) {
        return { code: 'NOT_TODAY', message: 'L’arrivée ne peut être enregistrée que le jour du rendez-vous' };
      }
      break;
    case 'no_show':
      if (ctx.now < ctx.startsAt) return { code: 'TOO_EARLY', message: 'Un patient ne peut être déclaré absent avant l’heure du rendez-vous' };
      break;
    case 'start':
    case 'complete':
      break;
  }
  return null;
}
