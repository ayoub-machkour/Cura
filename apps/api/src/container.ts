/**
 * Composition root : le SEUL endroit qui instancie et câble les dépendances.
 * Les classes reçoivent leurs dépendances par constructeur (injection) ;
 * les tests remplacent ce qu'ils veulent sans framework d'injection.
 */
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { type Clock, systemClock } from './common/clock';
import { type PasswordHasher, ScryptPasswordHasher } from './common/security/password-hasher';
import { AccessTokenService } from './common/security/tokens';
import type { Env } from './config/env';
import { createPool } from './infra/db/pool';
import { TransactionManager } from './infra/db/transaction';
import type { AppLogger } from './infra/logger';
import { createRedis } from './infra/redis';
import { AppointmentTypesRepository } from './modules/appointment-types/appointment-types.repository';
import { AppointmentTypesService } from './modules/appointment-types/appointment-types.service';
import { AuthRepository } from './modules/auth/auth.repository';
import { AuthService } from './modules/auth/auth.service';
import { BookingRepository } from './modules/booking/booking.repository';
import { BookingService } from './modules/booking/booking.service';
import type { SlotHoldStore } from './modules/booking/booking.ports';
import { RedisSlotHoldStore } from './modules/booking/slot-hold.store';
import { DoctorsRepository } from './modules/doctors/doctors.repository';
import { DoctorsService } from './modules/doctors/doctors.service';
import { PatientsRepository } from './modules/patients/patients.repository';
import { PatientsService } from './modules/patients/patients.service';
import { QueueRepository } from './modules/queue/queue.repository';
import { QueueService } from './modules/queue/queue.service';
import { OutboxRepository } from './modules/realtime/outbox.repository';
import { SlotsRepository } from './modules/slots/slots.repository';
import { SlotsService } from './modules/slots/slots.service';
import { VisitsService } from './modules/visits/visits.service';

export interface ContainerOverrides {
  pool?: Pool;
  redis?: Redis;
  clock?: Clock;
  hasher?: PasswordHasher;
  holds?: SlotHoldStore;
}

export function createContainer(env: Env, logger: AppLogger, overrides: ContainerOverrides = {}) {
  const pool = overrides.pool ?? createPool(env, logger);
  const redis = overrides.redis ?? createRedis(env, logger);
  const clock = overrides.clock ?? systemClock;
  const tx = new TransactionManager(pool);

  // Repositories (SQL)
  const authRepo = new AuthRepository(pool);
  const patientsRepo = new PatientsRepository(pool);
  const doctorsRepo = new DoctorsRepository(pool);
  const typesRepo = new AppointmentTypesRepository(pool);
  const slotsRepo = new SlotsRepository(pool);
  const bookingRepo = new BookingRepository(pool);
  const queueRepo = new QueueRepository(pool);
  const outboxRepo = new OutboxRepository(pool);

  // Sécurité
  const hasher = overrides.hasher ?? new ScryptPasswordHasher();
  const accessTokens = new AccessTokenService({
    secret: env.JWT_ACCESS_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    ttlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  });
  const holds = overrides.holds ?? new RedisSlotHoldStore(redis);

  // Services (logique métier)
  const services = {
    auth: new AuthService({
      tx,
      auth: authRepo,
      patients: patientsRepo,
      hasher,
      accessTokens,
      refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      logger: logger.child({ module: 'auth' }),
    }),
    patients: new PatientsService(patientsRepo, logger.child({ module: 'patients' })),
    doctors: new DoctorsService(doctorsRepo, logger.child({ module: 'doctors' })),
    appointmentTypes: new AppointmentTypesService(typesRepo, logger.child({ module: 'appointment-types' })),
    slots: new SlotsService({
      slots: slotsRepo,
      doctors: doctorsRepo,
      types: typesRepo,
      clock,
      logger: logger.child({ module: 'slots' }),
      minLeadMinutes: env.BOOKING_MIN_LEAD_MINUTES,
    }),
    booking: new BookingService({
      tx,
      appointments: bookingRepo,
      slots: slotsRepo,
      types: typesRepo,
      holds,
      clock,
      logger: logger.child({ module: 'booking' }),
      config: {
        lockTimeoutMs: env.BOOKING_LOCK_TIMEOUT_MS,
        minLeadMinutes: env.BOOKING_MIN_LEAD_MINUTES,
        holdTtlSeconds: env.BOOKING_HOLD_TTL_SECONDS,
        alternativesCount: 3,
      },
    }),
    visits: new VisitsService({ tx, appointments: bookingRepo, clock, logger: logger.child({ module: 'visits' }) }),
    queue: new QueueService(queueRepo, clock),
  };

  return {
    env,
    logger,
    pool,
    redis,
    accessTokens,
    tx,
    clock,
    repositories: { auth: authRepo, patients: patientsRepo, outbox: outboxRepo },
    hasher,
    services,
    async close() {
      await Promise.allSettled([pool.end(), redis.quit()]);
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
