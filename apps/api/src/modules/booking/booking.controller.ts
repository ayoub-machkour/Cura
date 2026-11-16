/**
 * Couche HTTP : validation des entrées, extraction de l'identité, mapping vers le service.
 * Aucune règle métier ici.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppointmentDto, BookAppointmentRequest, type SlotHoldResponse } from '@medcine/shared';
import { SlotUnavailableError } from './booking.errors';
import type { AppointmentRow, SlotHoldStore } from './booking.ports';
import type { BookingService } from './booking.service';

declare module 'fastify' {
  interface FastifyRequest {
    /** Renseigné par le hook d'authentification (JWT patient). */
    auth?: { patientId: string };
  }
}

export interface BookingRoutesDeps {
  service: BookingService;
  holds: SlotHoldStore;
  holdTtlMs: number;
}

const SlotParams = z.object({ slotId: z.string().uuid() });
const HoldBody = z.object({ appointmentTypeId: z.string().uuid() });

function requirePatientId(req: FastifyRequest): string {
  const patientId = req.auth?.patientId;
  if (!patientId) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  return patientId;
}

function toAppointmentDto(a: AppointmentRow): AppointmentDto {
  return AppointmentDto.parse({
    ...a,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
  });
}

export const bookingRoutes =
  ({ service, holds, holdTtlMs }: BookingRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * POST /v1/slots/:slotId/hold — le patient vient de toucher un créneau.
     * Pré-réservation de quelques minutes pendant qu'il confirme son motif.
     */
    app.post('/v1/slots/:slotId/hold', async (req, reply) => {
      const patientId = requirePatientId(req);
      const { slotId } = SlotParams.parse(req.params);
      const { appointmentTypeId } = HoldBody.parse(req.body);

      const hold = await holds.acquire(slotId, patientId, holdTtlMs);
      if (!hold) {
        const alternatives = await service.findAlternatives({ slotId, appointmentTypeId, patientId, source: 'mobile' });
        throw new SlotUnavailableError(slotId, 'HELD_BY_OTHER', alternatives);
      }
      const body: SlotHoldResponse = { slotId, holdToken: hold.token, expiresAt: hold.expiresAt.toISOString() };
      return reply.code(200).send(body);
    });

    /**
     * POST /v1/appointments — réservation définitive.
     * 201 : créé · 200 : rejeu idempotent · 409 : créneau pris (+ alternatives).
     */
    app.post('/v1/appointments', async (req, reply) => {
      const patientId = requirePatientId(req);
      const body = BookAppointmentRequest.parse(req.body);
      // Tolérance : un en-tête Idempotency-Key standard a priorité s'il est présent.
      const headerKey = req.headers['idempotency-key'];
      const idempotencyKey = typeof headerKey === 'string' ? z.string().uuid().parse(headerKey) : body.idempotencyKey;

      const result = await service.book({
        patientId,
        slotId: body.slotId,
        appointmentTypeId: body.appointmentTypeId,
        idempotencyKey,
        holdToken: body.holdToken,
        note: body.note,
        source: 'mobile',
      });

      return reply.code(result.replayed ? 200 : 201).send(toAppointmentDto(result.appointment));
    });
  };
