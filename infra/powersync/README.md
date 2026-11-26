# PowerSync Optional Cloud-Sync Blueprint (Roadmap / Non-Active)

> **Status:** Reference blueprint only — not required for the active production stack (`apps/api`, `apps/web`, `apps/pos`, `services/analytics`).

`sync-rules.yaml` captures the bucket sync rules for an optional future PowerSync deployment if multi-store offline SQLite replication is enabled beyond the current IndexedDB + append-only PostgreSQL ledger architecture.

- Not included in `infra/docker-compose.yml` or `infra/docker-compose.prod.yml`.
- Keep aligned with `apps/api/src/db/schema.ts` whenever enabling PowerSync in a future phase.
