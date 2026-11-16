# Medcine — Gestion de cabinet médical

Monorepo **pnpm + Turborepo**, 100 % TypeScript. Les contrats d'API (Zod) sont partagés
entre le serveur, l'application cabinet et l'application mobile : un champ renommé côté API
casse la compilation des clients, pas la production.

## 1. Architecture des dossiers

```
medcine/
├── apps/
│   ├── api/                         Fastify + PostgreSQL + Redis : SEULE source de vérité
│   │   ├── src/
│   │   │   ├── main.ts / app.ts     Composition root : instancie et câble les dépendances
│   │   │   ├── config/              Variables d'environnement validées par Zod au démarrage
│   │   │   ├── http/                error-handler, auth (JWT), rate-limit, CORS
│   │   │   ├── infra/
│   │   │   │   ├── db/              Pool pg, withTransaction, migrations runner
│   │   │   │   ├── redis/
│   │   │   │   ├── realtime/        Gateway Socket.io + relais Outbox → événements live
│   │   │   │   └── push/            Expo Push (notifications mobiles)
│   │   │   ├── modules/             Un dossier par contexte métier
│   │   │   │   ├── booking/         ← réservation concurrente (implémenté)
│   │   │   │   │   ├── booking.controller.ts   HTTP : validation, identité → service
│   │   │   │   │   ├── booking.service.ts      Règles métier + transaction
│   │   │   │   │   ├── booking.repository.ts   SQL (PostgreSQL)
│   │   │   │   │   ├── booking.ports.ts        Interfaces (DIP)
│   │   │   │   │   ├── booking.errors.ts       Erreurs métier typées
│   │   │   │   │   └── slot-hold.store.ts      Pré-réservation Redis (TTL)
│   │   │   │   ├── scheduling/      Planning médecin → génération des slots
│   │   │   │   ├── agenda/          Vues jour/semaine/mois, déplacement de RDV
│   │   │   │   ├── queue/           File d'attente live (check-in, statuts)
│   │   │   │   ├── billing/         Actes, factures, paiements, clôture de caisse
│   │   │   │   ├── patients/
│   │   │   │   ├── health-record/   Ordonnances, comptes-rendus (stockage chiffré)
│   │   │   │   └── notifications/   Rappels J-1 / H-2 (BullMQ, jobs différés)
│   │   └── test/                    Tests d'intégration sur vraie base PostgreSQL
│   │
│   ├── cabinet/                     React + Vite + Tailwind (+ shell Tauri pour le desktop)
│   │   ├── src/features/{agenda,queue,billing,patients}/
│   │   ├── src/shared/{api,realtime,ui}/
│   │   └── src-tauri/
│   │
│   └── mobile/                      Expo (React Native) + expo-router + NativeWind
│       ├── app/(auth)/  app/(tabs)/{home,booking,records,profile}/
│       └── src/features/
│
└── packages/
    ├── shared/                      Contrats Zod + types (API ⇄ clients)
    ├── db/migrations/               Migrations SQL versionnées
    ├── api-client/                  Client typé + hooks TanStack Query (optimistic UI)
    ├── ui-tokens/                   Design tokens communs Tailwind / NativeWind
    └── config/                      tsconfig, ESLint, Prettier partagés
```

### Décision d'architecture n°1 : une seule base qui accepte les réservations

Le cahier des charges évoque un « backend local » au cabinet **et** une app mobile qui réserve
en libre-service. Si le cabinet et le cloud avaient chacun leur base modifiable, deux patients
pourraient réserver le même créneau sur deux bases différentes. **Aucun verrou ne peut empêcher
ça** : il faudrait une synchronisation multi-maître, avec résolution de conflits après coup.

**Recommandation :** une API centrale hébergée (PostgreSQL managé, chez un hébergeur certifié
pour les données de santé selon le pays) qui reste la seule source de vérité. L'app cabinet en est
un client rapide : cache local, Optimistic UI, WebSocket. Pour fonctionner sans Internet, le cabinet
garde une réplique en lecture seule et une file d'actions hors-ligne réservée à ce qui ne crée pas
de conflit (encaissements, notes). L'agenda passe en lecture seule tant que la connexion est coupée.

### Décision n°2 : Tauri plutôt qu'Electron pour le desktop
Même code React. Binaire d'environ 10 Mo au lieu d'environ 150 Mo, et nettement moins de RAM
sur les PC souvent modestes d'un secrétariat. Accès natif à l'impression des reçus.

## 2. Schéma de base de données

Voir [`packages/db/migrations/0001_init.sql`](packages/db/migrations/0001_init.sql).

| Table | Rôle | Garanties clés |
|---|---|---|
| `doctors` | Praticiens | `registration_number` UNIQUE |
| `patients` | Dossiers | `national_id` UNIQUE partiel ; pas d'UNIQUE sur le téléphone (familles) |
| `appointment_types` | Motifs (durée, couleur agenda) | `color_hex` validé |
| `slots` | Créneaux générés | `EXCLUDE` : aucun chevauchement par médecin |
| `appointments` | RDV | voir ci-dessous |
| `invoices` / `invoice_items` / `payments` | Caisse | centimes en `bigint`, numérotation sans trou, facture émise immuable (trigger) |
| `outbox_events` | Événements transactionnels | publiés après commit (temps réel + rappels) |

**Trois verrous complémentaires contre la double réservation (dans `appointments`) :**
1. `uq_appointments_active_slot` : un seul RDV actif par créneau ;
2. `ex_appointments_doctor_overlap` : aucun chevauchement pour un médecin, y compris pour les walk-ins sans créneau ;
3. `ex_appointments_patient_overlap` : un patient ne peut pas avoir deux RDV à la même heure.

De plus, la FK composite `(slot_id, doctor_id, starts_at, ends_at)` empêche qu'un RDV dise un horaire
différent de celui de son créneau.

Le statut « réservé » n'est **pas** stocké dans `slots`. Il se déduit de l'existence d'un RDV actif.
Annuler un RDV libère donc le créneau, sans risque de désynchronisation entre deux colonnes.

## 3. Réservation concurrente

Code : [`apps/api/src/modules/booking/booking.service.ts`](apps/api/src/modules/booking/booking.service.ts)

```
Patient A ──┐                                   Patient B ──┐
            ▼                                               ▼
   BEGIN                                           BEGIN
   SELECT … FROM slots WHERE id=X FOR UPDATE  ✔    SELECT … FOR UPDATE   ⏳ attend A
   EXISTS(RDV actif sur X) ? → non                          │
   INSERT appointment + INSERT outbox_event                 │
   COMMIT ──────────────────────────────────────────────────┤ verrou obtenu
   201 Created                                     EXISTS(RDV actif sur X) ? → OUI
                                                   ROLLBACK
                                                   → alternatives les plus proches (hors transaction)
                                                   409 { reason: ALREADY_BOOKED, alternatives: [...] }
```

| Couche | Rôle | Si elle tombe |
|---|---|---|
| Redis `SET NX PX` (pré-réservation de 5 min à la sélection) | UX : le patient ne remplit pas un formulaire pour un créneau déjà pris | Dégradation silencieuse : PostgreSQL reste l'arbitre |
| `SELECT … FOR UPDATE` + `lock_timeout` | Sérialise les réservations d'un **même** créneau ; les autres créneaux ne se bloquent pas entre eux | — |
| Contraintes `EXCLUDE` / `UNIQUE` | Filet de sécurité absolu, même si le code a un bug | — |

En plus : une **clé d'idempotence** générée par le client. Un retry réseau ou un double tap renvoie
le même RDV (200) au lieu d'un faux conflit. Un **outbox transactionnel** garantit qu'un événement
`appointment.booked` est publié vers l'agenda live et les rappels J-1/H-2 si et seulement si le RDV
a été commité.

**UX mobile en cas de 409 :** la feuille de réservation reste ouverte. Le créneau perdu se grise avec
une animation, et les alternatives apparaissent à sa place, la plus proche pré-sélectionnée. Le patient
confirme en un tap. On ne fait **pas** d'Optimistic UI sur la réservation elle-même, parce qu'afficher
« Réservé ✓ » puis le retirer serait pire. On l'utilise pour le reste : statuts de file d'attente,
encaissements, notes.

## Tests

```bash
pnpm install
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/medcine_test pnpm --filter @medcine/api test
```

`apps/api/test/booking.concurrency.test.ts` lance 50 réservations simultanées sur le même créneau et
vérifie qu'il y a exactement 1 gagnant, 49 rejets accompagnés d'alternatives, et 1 seule ligne en base.
