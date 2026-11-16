/**
 * Passerelle temps réel (Socket.io) — voir le contrat dans packages/shared/src/schemas/realtime.ts.
 *
 * Sécurité :
 * - Origin vérifiée AVANT la mise à niveau WebSocket (les WebSockets ne sont pas soumis
 *   à CORS : sans ce contrôle, un site tiers pourrait ouvrir une connexion avec le
 *   cookie de la victime — « Cross-Site WebSocket Hijacking »).
 * - Authentification par le même access token que l'API (cookie httpOnly ou auth.token).
 * - Déconnexion automatique à l'expiration du jeton : le client se reconnecte après refresh.
 * - Abonnements validés par Zod et limités par rôle et en nombre.
 *
 * Multi-instance : adaptateur Redis — un événement émis par une instance atteint les
 * clients connectés à toutes les autres.
 */
import { createAdapter } from '@socket.io/redis-adapter';
import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { REALTIME_PATH, type RealtimeEnvelope, type SubscribeAck, SubscribeRequest } from '@cura/shared';
import type { AccessTokenService, AuthPrincipal } from '../../common/security/tokens';
import { COOKIE } from '../../http/cookies';

export const rooms = {
  doctor: (doctorId: string) => `doctor:${doctorId}`,
  patient: (patientId: string) => `patient:${patientId}`,
};

/** Nombre maximal de salles « médecin » suivies par une connexion. */
export const MAX_SUBSCRIPTIONS = 50;

interface ClientToServerEvents {
  subscribe: (payload: unknown, ack?: (res: SubscribeAck) => void) => void;
  unsubscribe: (payload: unknown, ack?: (res: SubscribeAck) => void) => void;
}

type ServerToClientEvents = {
  [K in RealtimeEnvelope['type']]: (event: RealtimeEnvelope) => void;
} & {
  'session.expired': () => void;
};

interface SocketData {
  principal: AuthPrincipal;
  expiresAt: Date;
}

export type RealtimeServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

declare module 'fastify' {
  interface FastifyInstance {
    io: RealtimeServer;
  }
}

export interface RealtimeOptions {
  tokens: AccessTokenService;
  allowedOrigins: readonly string[];
  redis: Redis;
  keyPrefix: string;
}

export const realtimeGateway = fp<RealtimeOptions>(
  async (app, { tokens, allowedOrigins, redis, keyPrefix }) => {
    const allowed = new Set(allowedOrigins);
    const log = app.log.child({ module: 'realtime' });

    const io: RealtimeServer = new Server(app.server, {
      path: REALTIME_PATH,
      serveClient: false,
      cors: { origin: [...allowed], credentials: true },
      // Clients natifs (app mobile) : pas d'Origin. Navigateurs : liste blanche stricte.
      allowRequest: (req, cb) => {
        const origin = req.headers.origin;
        const ok = !origin || allowed.has(origin);
        if (!ok) log.warn({ event: 'realtime.origin_rejected', origin }, 'websocket origin rejected');
        cb(null, ok);
      },
      maxHttpBufferSize: 16 * 1024,
      pingInterval: 25_000,
      pingTimeout: 20_000,
    });

    const pub = redis.duplicate();
    const sub = redis.duplicate();
    io.adapter(createAdapter(pub, sub, { key: `${keyPrefix}socket.io` }));

    io.use((socket, next) => {
      const cookieHeader = socket.request.headers.cookie;
      const cookies = cookieHeader ? app.parseCookie(cookieHeader) : {};
      const explicit = socket.handshake.auth?.token;
      const token = typeof explicit === 'string' ? explicit : (cookies[COOKIE.access] ?? '');
      const session = tokens.verifySession(token);
      if (!session) {
        log.info({ event: 'realtime.auth_failed' }, 'websocket authentication failed');
        return next(new Error('UNAUTHORIZED'));
      }
      socket.data.principal = session.principal;
      socket.data.expiresAt = session.expiresAt;
      next();
    });

    io.on('connection', (socket) => {
      const principal = socket.data.principal;
      const slog = log.child({ socketId: socket.id, userId: principal.sub, role: principal.role });

      // Le jeton expire : on coupe, le client se reconnecte avec le cookie rafraîchi.
      const expiry = setTimeout(() => {
        socket.emit('session.expired');
        socket.disconnect(true);
      }, Math.max(socket.data.expiresAt.getTime() - Date.now(), 0));
      expiry.unref();

      if (principal.role === 'patient' && principal.pid) void socket.join(rooms.patient(principal.pid));
      if (principal.role === 'doctor' && principal.did) void socket.join(rooms.doctor(principal.did));

      const handle = (action: 'subscribe' | 'unsubscribe') => (payload: unknown, ack?: (res: SubscribeAck) => void) => {
        const reply = (res: SubscribeAck) => (typeof ack === 'function' ? ack(res) : undefined);
        const parsed = SubscribeRequest.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, code: 'VALIDATION_ERROR', message: 'doctorId (UUID) requis' });

        const { doctorId } = parsed.data;
        const allowedToFollow =
          principal.role === 'admin' || principal.role === 'secretary' || (principal.role === 'doctor' && principal.did === doctorId);
        if (!allowedToFollow) {
          slog.warn({ event: 'realtime.subscribe_forbidden', doctorId }, 'subscription denied');
          return reply({ ok: false, code: 'FORBIDDEN', message: 'Accès refusé' });
        }

        const room = rooms.doctor(doctorId);
        if (action === 'subscribe') {
          const current = [...socket.rooms].filter((r) => r.startsWith('doctor:')).length;
          if (!socket.rooms.has(room) && current >= MAX_SUBSCRIPTIONS) {
            return reply({ ok: false, code: 'TOO_MANY_SUBSCRIPTIONS', message: `Maximum ${MAX_SUBSCRIPTIONS} agendas suivis` });
          }
          void socket.join(room);
        } else {
          void socket.leave(room);
        }
        reply({ ok: true });
      };
      socket.on('subscribe', handle('subscribe'));
      socket.on('unsubscribe', handle('unsubscribe'));

      socket.on('disconnect', (reason) => {
        clearTimeout(expiry);
        slog.debug({ reason }, 'realtime disconnected');
      });
      slog.debug('realtime connected');
    });

    app.decorate('io', io);

    // Arrêt : on coupe les clients AVANT que Fastify ferme le serveur HTTP.
    app.addHook('preClose', (done) => {
      io.local.disconnectSockets(true);
      done();
    });
    app.addHook('onClose', async () => {
      // io.close() ferme aussi le serveur HTTP, déjà fermé par Fastify : l'erreur éventuelle est sans objet.
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.allSettled([pub.quit(), sub.quit()]);
    });
  },
  { name: 'realtime-gateway', dependencies: ['@fastify/cookie'] },
);
