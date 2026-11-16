import type { SlotDto, SlotUnavailableReason } from '@medcine/shared';

/**
 * Erreur métier : porte son code stable (contrat API) et son statut HTTP.
 * Le gestionnaire d'erreurs HTTP la sérialise sans connaître chaque cas (Open/Closed).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }

  /** Corps de la réponse HTTP. Surchargé pour enrichir (ex. alternatives). */
  toResponse(): Record<string, unknown> {
    return { code: this.code, message: this.message };
  }
}

export class SlotUnavailableError extends DomainError {
  readonly code = 'SLOT_UNAVAILABLE';
  readonly httpStatus = 409;

  constructor(
    readonly slotId: string,
    readonly reason: SlotUnavailableReason,
    /** Remplies par le service, HORS transaction, avant de remonter à l'appelant. */
    readonly alternatives: readonly SlotDto[] = [],
  ) {
    super(`Slot ${slotId} is unavailable (${reason})`);
  }

  withAlternatives(alternatives: readonly SlotDto[]): SlotUnavailableError {
    return new SlotUnavailableError(this.slotId, this.reason, alternatives);
  }

  override toResponse() {
    return {
      code: this.code,
      reason: this.reason,
      message: 'Ce créneau vient d’être réservé. Voici les disponibilités les plus proches.',
      alternatives: this.alternatives,
    };
  }
}

export class PatientTimeConflictError extends DomainError {
  readonly code = 'PATIENT_TIME_CONFLICT';
  readonly httpStatus = 409;
  constructor() {
    super('Vous avez déjà un rendez-vous sur cet horaire.');
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
  }
}

export class InvalidAppointmentTypeError extends DomainError {
  readonly code = 'INVALID_APPOINTMENT_TYPE';
  readonly httpStatus = 422;
  constructor(reason: string) {
    super(reason);
  }
}
