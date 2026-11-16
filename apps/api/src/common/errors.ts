/**
 * Erreurs métier. Chacune porte son code stable (contrat d'API) et son statut HTTP :
 * le gestionnaire d'erreurs les sérialise sans connaître chaque cas (Open/Closed).
 * Aucune de ces classes ne connaît Fastify ni PostgreSQL.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }

  /** Corps de la réponse HTTP (surchargé pour enrichir, ex. alternatives). */
  toResponse(): Record<string, unknown> {
    return { code: this.code, message: this.message };
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
  constructor(entity: string) {
    super(`${entity} introuvable`);
  }
}

export class ConflictError extends DomainError {
  readonly httpStatus = 409;
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class BusinessRuleError extends DomainError {
  readonly httpStatus = 422;
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class UnauthorizedError extends DomainError {
  readonly httpStatus = 401;
  constructor(readonly code = 'UNAUTHORIZED', message = 'Authentification requise') {
    super(message);
  }
}

export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
  constructor(message = 'Accès refusé') {
    super(message);
  }
}

export class BadRequestError extends DomainError {
  readonly httpStatus = 400;
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
