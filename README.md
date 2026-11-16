# Cura — Gestion de cabinet médical

Monorepo **pnpm + Turborepo**, 100 % TypeScript : API Fastify, PostgreSQL, Redis, Nginx.
Les contrats d'API et les règles de validation (Zod) sont partagés entre le serveur,
l'application cabinet et l'application mobile.

## Démarrage rapide

Prérequis : Node ≥ 22.12, pnpm 9 (`corepack enable`), Docker Desktop.

```bash
pnpm install
cp .env.example .env                 # puis remplacer les valeurs « change-me »

# Option A — tout dans Docker (bases, Redis, migrations, API, Nginx)
docker compose up -d --build
# → API : http://localhost:8080/api/v1   Swagger : http://localhost:8080/docs

# Option B — infrastructure dans Docker, API en local (rechargement à chaud)
pnpm db:up                           # postgres, postgres-test, redis, redis-test
pnpm db:migrate                      # applique les migrations sur cura_dev
pnpm --filter @cura/api create-admin # premier compte admin (ADMIN_EMAIL / ADMIN_PASSWORD du .env)
pnpm --filter @cura/api dev          # → http://localhost:3000/docs
```

## Architecture

```
cura/
├── apps/api/                       Fastify + PostgreSQL + Redis
│   ├── Dockerfile                  build multi-étapes, utilisateur non-root, tini
│   ├── src/
│   │   ├── main.ts                 démarrage + arrêt propre (SIGTERM)
│   │   ├── app.ts                  plugins, sécurité, routes /api/v1
│   │   ├── container.ts            composition root (injection de dépendances)
│   │   ├── migrate.ts              CLI de migration
│   │   ├── config/env.ts           validation Zod des variables d'environnement
│   │   ├── common/                 erreurs métier, pagination, sécurité (hash, JWT)
│   │   ├── http/                   auth-guard (RBAC + CSRF), cookies, helmet/CORS/rate-limit, Swagger, erreurs
│   │   ├── infra/                  pool PostgreSQL, transactions, migrateur, Redis, logger
│   │   └── modules/<domaine>/
│   │       ├── *.routes.ts         CONTRÔLEUR : schémas Zod, rôles, délégation au service
│   │       ├── *.service.ts        LOGIQUE MÉTIER : aucun SQL, aucun objet HTTP
│   │       └── *.repository.ts     ACCÈS DONNÉES : SQL paramétré uniquement
│   └── test/{unit,integration}/
├── packages/
│   ├── shared/                     constraints.ts (règles) + schémas Zod partagés
│   └── db/migrations/              NNNN_nom.up.sql / NNNN_nom.down.sql
├── nginx/                          reverse proxy (dev HTTP, prod TLS)
├── docker-compose.yml              développement
└── docker-compose.prod.yml         production
```

Modules : `auth`, `patients`, `doctors`, `appointment-types`, `slots`, `booking`, `visits` (parcours de visite), `queue` (file d’attente), `realtime` (Socket.io + relais outbox), `health`.

## Bases de données : dev, test et prod séparées

| Base | Conteneur | Port (127.0.0.1) | Persistance | Usage |
|---|---|---|---|---|
| `cura_dev` | `postgres` | 5432 | volume | développement |
| `cura_test` | `postgres-test` | 5433 | RAM (tmpfs) | tests automatisés |
| `cura_prod` | `docker-compose.prod.yml` | non exposé | volume dédié | production |

Les tests **refusent de démarrer** si la base visée ne se termine pas par `_test`, si `NODE_ENV` n'est pas `test`,
ou si le préfixe Redis ne contient pas `test` ([guard.ts](apps/api/test/integration/guard.ts)). Redis suit le même
schéma : `redis` (6379) pour le dev et `redis-test` (6380) pour les tests.

## Migrations

```bash
pnpm --filter @cura/api migrate up            # appliquer
pnpm --filter @cura/api migrate status        # état
pnpm --filter @cura/api migrate down 1        # annuler la dernière (interdit en production)
pnpm --filter @cura/api migrate:create add_x  # créer 0003_add_x.up.sql / .down.sql
```

- Chaque migration s'exécute dans sa propre transaction (tout ou rien).
- Un verrou consultatif empêche deux migrations simultanées (plusieurs conteneurs au déploiement).
- Une somme de contrôle bloque l'exécution si une migration **déjà appliquée** a été modifiée.
  Toute évolution passe par une nouvelle migration (exemple : `0002_auth` ajoute des FK sur des tables existantes).
- En Docker, le service `migrate` s'exécute avant l'API. L'API ne démarre que si les migrations ont réussi.

## Validation : une règle, deux remparts

[`packages/shared/src/constraints.ts`](packages/shared/src/constraints.ts) définit chaque règle une seule fois
(longueurs, regex E.164, noms, anti-XSS…) :

- **Zod** l'applique sur **toutes** les routes qui reçoivent des données (body, query, params), côté API et clients.
- **PostgreSQL** l'applique en `CHECK` / `DOMAIN` (`person_name`, `phone_e164`, `email_address`, `safe_text`…).
- Le test de contrat [`db-constraints.contract.test.ts`](apps/api/test/integration/db-constraints.contract.test.ts)
  vérifie que Zod et la base rendent **le même verdict** pour chaque règle.

Les champs hors schéma sont ignorés, ce qui empêche l'assignation de masse.

## Sécurité

| Mesure | Implémentation |
|---|---|
| En-têtes HTTP | `@fastify/helmet` : CSP `default-src 'none'`, nosniff, frameguard, referrer-policy, HSTS en prod |
| CORS | liste blanche explicite (`CORS_ORIGINS`), credentials, jamais `*` |
| XSS | rejet des balises HTML dans tout texte libre (Zod + domaine SQL `safe_text`), réponses JSON uniquement, CSP stricte, `Cache-Control: no-store` |
| Session | access token JWT HS256 de 15 min dans un cookie **httpOnly**, `SameSite=Strict`, `Secure` en prod |
| Refresh token | opaque, cookie **httpOnly** limité à `/api/v1/auth`, **stocké haché** (SHA-256), **rotation** à chaque usage, **réutilisation détectée** : toute la famille est révoquée |
| CSRF | double-submit (`cura_csrf` + en-tête `x-csrf-token`), comparaison à temps constant |
| Mots de passe | scrypt (N=2¹⁵, r=8), 12 caractères minimum, re-hachage transparent si les paramètres sont durcis |
| Force brute | verrouillage 15 min après 5 échecs, même réponse pour un email inconnu ou un mauvais mot de passe (pas d'énumération) |
| Rate limiting | Nginx (`limit_req`) + API (`@fastify/rate-limit` partagé via Redis), limite stricte sur login/register |
| RBAC | rôles `admin`, `doctor`, `secretary`, `patient` : `app.authorize(...)` sur chaque route ; un patient n'accède qu'à ses données (404 et non 403 sur les données d'autrui) |
| SQL | requêtes paramétrées uniquement ; noms de colonnes dynamiques issus de listes blanches |
| Conteneurs | utilisateur non-root, système de fichiers en lecture seule, `cap_drop: ALL`, `no-new-privileges` (prod) ; ports dev liés à 127.0.0.1 |
| Secrets | `.env*` exclus de Git et de l'image Docker ; seuls les `*.example` sont versionnés |

## Logs

Logs JSON structurés (pino) en production, format lisible en dev (`LOG_PRETTY=true`).
- Chaque requête porte un `reqId`, généré par Nginx (`$request_id`) et transmis à l'API.
  Il est renvoyé au client dans `x-request-id` et figure dans chaque réponse d'erreur.
- Événements métier nommés (`auth.login_failed`, `appointment.booked`, `auth.refresh_reuse_detected`…).
- Données sensibles masquées : cookies, `authorization`, mots de passe, jetons.
  Les query strings ne sont pas loggées, car elles peuvent contenir un nom de patient.

## API (v1)

Documentation interactive sur **`/docs`** (OpenAPI 3.1 générée depuis les schémas Zod, désactivée en production).

| Méthode | Route | Rôles |
|---|---|---|
| POST | `/api/v1/auth/register` · `/login` · `/refresh` · `/logout` | public / session |
| GET | `/api/v1/auth/me` | connecté |
| POST | `/api/v1/users` | admin |
| GET/POST/PATCH | `/api/v1/patients[/:id]` (liste paginée + recherche `q`) | personnel |
| GET/PATCH | `/api/v1/patients/me` | patient |
| GET/POST | `/api/v1/doctors[/:id]` | connecté / admin |
| GET/POST/PATCH | `/api/v1/appointment-types[/:id]` | connecté / admin |
| GET | `/api/v1/doctors/:doctorId/slots` (disponibilités paginées) | connecté |
| POST | `/api/v1/doctors/:doctorId/slots/generate` | admin, secrétaire |
| POST | `/api/v1/slots/:slotId/hold` (pré-réservation Redis) | patient |
| POST | `/api/v1/appointments` (201 · 200 rejeu · 409 + alternatives) | patient, personnel |
| POST | `/api/v1/appointments/:id/cancel` | propriétaire, personnel |
| GET | `/api/v1/appointments/me` · `/api/v1/appointments` (agenda) | patient · personnel |
| POST | `/api/v1/appointments/:id/confirm` · `/check-in` · `/start` · `/complete` · `/no-show` | selon l’action (voir « File d’attente ») |
| POST | `/api/v1/walk-ins` (patient sans RDV → salle d’attente) | secrétariat, admin, médecin (sa file) |
| POST | `/api/v1/patients/:id/invitations` (code d’activation de l’app) | personnel |
| POST | `/api/v1/auth/claim` (activer son compte avec le code) | public |
| GET | `/api/v1/queue?doctorId=` (file du jour) | personnel (médecin : sa file) |
| GET | `/api/v1/appointments/:id/queue-position` | propriétaire, personnel |
| GET | `/health/live` · `/health/ready` | public |

**Pagination** par curseur (keyset) : `?limit=20&cursor=…` renvoie `{ data, page: { limit, nextCursor, hasMore } }`.
Le coût reste constant quelle que soit la page, et le curseur est opaque et revalidé.

## Réservation concurrente

Trois niveaux de protection, détaillés dans [`booking.service.ts`](apps/api/src/modules/booking/booking.service.ts) :

1. **Redis** : pré-réservation TTL quand le patient sélectionne un créneau. C'est une aide UX : si Redis tombe, la réservation continue.
2. **`SELECT … FOR UPDATE`** + `lock_timeout` : sérialise les réservations d'un même créneau.
3. **Contraintes PostgreSQL** (`EXCLUDE` + index unique partiel) : aucune double réservation n'est possible, même avec un bug applicatif.

En cas de collision, l'API répond **409** avec les 3 créneaux libres les plus proches. Une clé d'idempotence rend
les retries réseau sûrs. Un outbox transactionnel prépare le temps réel et les rappels J-1 / H-2.

## File d'attente et temps réel

**Parcours de visite.** Il est implémenté dans [`visit-state-machine.ts`](apps/api/src/modules/visits/visit-state-machine.ts), un module pur testé sur toutes les combinaisons action × statut :

```
scheduled ─confirm─▶ confirmed ─check-in─▶ checked_in ─start─▶ in_consultation ─complete─▶ completed
     └──────────────────┴──no-show──▶ no_show            (annulation : scheduled / confirmed uniquement)
```

| Action | Rôles | Règle |
|---|---|---|
| `confirm` | patient (ses RDV), secrétariat, admin | RDV futur |
| `check-in` | secrétariat, admin, médecin (son agenda) | le jour du RDV, dans le fuseau du médecin |
| `start` / `complete` | médecin (son agenda), admin | un seul patient en consultation par médecin |
| `no-show` | secrétariat, admin, médecin (son agenda) | pas avant l'heure du RDV |

Chaque transition s'exécute dans **une seule transaction**, qui :
- verrouille la ligne du RDV ;
- contrôle la version (`expectedVersion` optionnel → 409 `STALE_VERSION`) ;
- applique la machine à états ;
- écrit l'historique et l'événement outbox.

La base garantit en plus :
- l'horodatage obligatoire de chaque statut et une chronologie cohérente ;
- **une seule consultation en cours par médecin** (index unique, testé en concurrence) ;
- un historique `appointment_status_changes` **en ajout seul** (trigger).

**File du jour.** `GET /api/v1/queue?doctorId=` renvoie la consultation en cours, la salle d'attente (premier arrivé, premier appelé, avec la position) et les patients attendus (retards signalés). Le patient obtient sa place avec `GET /appointments/:id/queue-position`.

**Temps réel.** Socket.io sur `/socket.io`, contrat dans [`realtime.ts`](packages/shared/src/schemas/realtime.ts) :
- Authentification par le cookie httpOnly de session (ou `auth.token` pour un client natif). La connexion est coupée à l'expiration du jeton (événement `session.expired`).
- **Origin vérifiée** avant la mise à niveau WebSocket, contre le *Cross-Site WebSocket Hijacking*.
- Salles : un patient reçoit uniquement ses propres RDV ; un médecin reçoit son agenda ; le secrétariat émet `subscribe { doctorId }` (50 agendas maximum par connexion).
- Événements : `appointment.booked`, `appointment.cancelled`, `appointment.status_changed`.
- Livraison **au moins une fois** : dédupliquer par `id`, comparer `data.version`.
- Le relais de l'outbox lit les événements avec `FOR UPDATE SKIP LOCKED`, sans doublon même avec plusieurs instances. L'adaptateur Redis relie les instances entre elles, et les événements publiés sont purgés après `OUTBOX_RETENTION_DAYS`.

## Patients sans compte, walk-in et activation de l'app

**Principe : le dossier patient appartient au cabinet, le compte appartient au patient.** Ce sont deux entités
séparées (`patients` ≠ `users`), ce qui permet de servir tout le monde.

- **Patients sans smartphone ou âgés.** Le secrétariat crée le dossier et gère tout au guichet. Ces patients n'ont jamais besoin de l'app.
- **Walk-in (sans rendez-vous).** `POST /api/v1/walk-ins` crée une visite **sans créneau**, directement en salle d'attente :
  - elle s'intercale par ordre d'arrivée avec les patients sur RDV ;
  - elle n'occupe pas l'agenda, car c'est la file qui la gère ;
  - la base garantit qu'un patient n'est **qu'une fois** en file (index unique) ;
  - un patient reparti sans consulter est clôturé par le personnel, et pourra revenir.
- **Activation de l'app pour un patient déjà connu.** Le secrétariat génère un code (`POST /patients/:id/invitations`, ex. `K7QM-4XRP`), à imprimer ou dicter. Le patient saisit **code + date de naissance** dans l'app (`POST /auth/claim`). Son compte est rattaché à **son dossier existant** et il retrouve automatiquement tout son historique, sans doublon.
  - Pas de rattachement automatique par téléphone : une famille partage un numéro, et les numéros sont recyclés.
  - Code d'environ 40 bits, alphabet sans ambiguïté (pas de 0/O, 1/I/L), **stocké haché**, usage unique, expiration 7 jours, une seule invitation active par patient.
  - Blocage après 5 dates de naissance erronées. Même réponse pour un code inconnu ou une mauvaise date, donc pas d'énumération. Le code n'apparaît jamais dans les logs.
- **Nouveau patient inconnu du cabinet.** Inscription libre dans l'app (`POST /auth/register`).

**Anti-accaparement.** En ligne, un patient a au plus `BOOKING_MAX_ACTIVE_PER_PATIENT` RDV à venir (3 par défaut, sans limite pour le secrétariat). Les réservations d'un même patient sont sérialisées (verrou sur son dossier) : 5 réservations simultanées donnent exactement 3 RDV.

## Test de charge

```bash
pnpm db:up && pnpm --filter @cura/api load:test     # base de TEST uniquement (garde-fou)
```

Le test vérifie après chaque scénario qu'il n'y a **aucune erreur serveur et aucune double réservation**. Mesures sur un poste de développement Windows avec Docker Desktop (API, PostgreSQL et Redis sur la même machine, pool de 25 connexions). Elles sont indicatives : elles servent à voir la **tendance**, pas une capacité de production.

| Scénario | Résultat |
|---|---|
| Ruée : 200 patients sur 20 créneaux, simultanément | 20 × 201, 180 × 409 avec alternatives, 0 erreur, 0 double réservation |
| Même client × 5 : 50 patients × 5 réservations simultanées | exactement 3 RDV par patient, 0 erreur |
| Charge mixte, concurrence 1 → 25 | p95 de 44 à 113 ms, débit qui monte jusqu'à environ 500 req/s |
| Charge mixte, concurrence 50 → 100 | débit plafonné (~500 req/s), p95 de 207 à 402 ms, requêtes en attente de connexion |

**Lecture :** jusqu'à environ 25 requêtes simultanées, le système monte en débit sans attente. Au-delà, le **pool PostgreSQL est le goulot**. La latence augmente alors proportionnellement, sans erreur ni incohérence : le système se dégrade proprement. Pour un cabinet, c'est une marge très large. Pour un réseau de cabinets, les leviers sont : plusieurs instances de l'API (déjà compatibles grâce au relais et à l'adaptateur Redis), PgBouncer, un pool plus grand, et un cache Redis sur les lectures de disponibilités. La ruée est plus lente (p50 ~1,5 s), car chaque perdant calcule ses alternatives pendant que 200 requêtes se disputent 25 connexions.

## Tests

```bash
pnpm db:up                           # postgres-test + redis-test doivent tourner
pnpm --filter @cura/api test         # unitaires + intégration
pnpm --filter @cura/api test:unit    # sans Docker
```

324 tests (97,8 % des lignes couvertes, `pnpm --filter @cura/api test:coverage`), dont :
- 50 réservations simultanées sur le même créneau : exactement 1 gagnant ;
- rejeu idempotent ;
- rotation et vol de refresh token ;
- CSRF, RBAC, XSS, rate limiting, en-têtes de sécurité ;
- pagination sur 45 patients sans doublon ;
- contrat Zod ⇄ PostgreSQL ;
- réversibilité des migrations et détection de modification ;
- chaque route testée pour chaque rôle et chaque règle métier (créneau bloqué, délai de prévenance, motif trop long…) ;
- résilience : base indisponible (500 sans fuite, health 503), verrou bloqué (409 au lieu d’une attente infinie) ;
- parcours de visite (35 combinaisons action × statut), un seul patient en consultation même en concurrence ;
- temps réel de bout en bout (vraies connexions WebSocket) : authentification, Origin, isolation des salles, expiration de session, relais multi-instance sans doublon ;
- 5 réservations simultanées d’un même client (limite tenue), walk-ins (double clic, file unique), activation par code (force brute, usage unique, activation concurrente).

## Feuille de route

- [x] File d'attente live et agenda temps réel (Socket.io, relais de l'outbox)
- [ ] Caisse et facturation (tables prêtes : numérotation sans trou, factures immuables)
- [ ] Rappels J-1 / H-2 (BullMQ sur Redis + Expo Push)
- [ ] Application cabinet (React + Vite) et application mobile (Expo)
- [ ] CI GitHub Actions (tests sur conteneurs de service)

## Postman

La collection [`postman/collections/Cura API`](postman/collections/Cura%20API) couvre toutes les routes.
- La session passe par le gestionnaire de cookies de Postman : rien à copier à la main.
- Le jeton CSRF est ajouté automatiquement aux requêtes POST/PATCH.
- Les identifiants (`doctor_id`, `slot_id`…) sont enregistrés par les requêtes qui les créent.

Ordre conseillé : `create-admin` (terminal) → Login → Create doctor → Create appointment type → Generate slots →
Register patient → List available slots → Book appointment.
