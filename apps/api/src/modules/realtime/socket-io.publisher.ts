import { RealtimeEnvelope } from '@cura/shared';
import type { AppLogger } from '../../infra/logger';
import type { EventPublisher } from './outbox.relay';
import type { OutboxRecord } from './outbox.repository';
import { type RealtimeServer, rooms } from './realtime.gateway';

/**
 * Diffuse un événement de l'outbox vers les salles concernées :
 * l'agenda du médecin et le patient lui-même — personne d'autre.
 * Le contenu est revalidé par le contrat partagé avant émission.
 */
export class SocketIoPublisher implements EventPublisher {
  constructor(
    private readonly io: RealtimeServer,
    private readonly logger: AppLogger,
  ) {}

  publish(event: OutboxRecord): boolean {
    const parsed = RealtimeEnvelope.safeParse({
      id: event.id,
      type: event.eventType,
      occurredAt: event.createdAt.toISOString(),
      data: event.payload,
    });
    if (!parsed.success) {
      this.logger.error({ eventId: event.id, eventType: event.eventType, issues: parsed.error.issues }, 'invalid outbox event');
      return false;
    }
    const envelope = parsed.data;
    this.io.to(rooms.doctor(envelope.data.doctorId)).to(rooms.patient(envelope.data.patientId)).emit(envelope.type, envelope);
    return true;
  }
}
