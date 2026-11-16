import type { SlotDto, SlotUnavailableReason } from '@cura/shared';
import { DomainError } from '../../common/errors';

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
      message:
        this.alternatives.length > 0
          ? 'Ce créneau n’est plus disponible. Voici les disponibilités les plus proches.'
          : 'Ce créneau n’est plus disponible.',
      alternatives: [...this.alternatives],
    };
  }
}

export class PatientTimeConflictError extends DomainError {
  readonly code = 'PATIENT_TIME_CONFLICT';
  readonly httpStatus = 409;
  /** Le prénom rend le message compréhensible quand un parent réserve pour plusieurs enfants. */
  constructor(firstName?: string) {
    super(
      firstName
        ? `${firstName} a déjà un rendez-vous sur cet horaire. Choisissez un autre créneau ou un autre membre de la famille.`
        : 'Ce patient a déjà un rendez-vous sur cet horaire. Choisissez un autre créneau.',
    );
  }
}

/** Interne : la clé d'idempotence existe déjà → le service renvoie le RDV existant. */
export class DuplicateIdempotencyKeyError extends Error {
  constructor() {
    super('Duplicate idempotency key');
    this.name = 'DuplicateIdempotencyKeyError';
  }
}
