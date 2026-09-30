# DDI V1.1A production runtime closure

Production configuration is explicitly selected with `DDI_ENV=production`, independent of `NODE_ENV`. It requires PostgreSQL `DATABASE_URL`, `TRUSTID_ISSUER`, `TRUSTID_AUDIENCE`, `TRUSTID_JWKS_URL`, and one or more `DDI_ALLOWED_ORIGINS`; invalid or absent values stop startup. JSON persistence remains test-only and is never a production fallback.

`migrations/001_ddi_foundation.sql` is applied only by an explicit migration operation. The migration helper rejects destructive SQL and uses a transaction; normal service boot does not migrate, reset, seed, drop, or recreate data.

The Fastify API surface is implemented in `apps/api/src/app.ts`. It exposes health, authenticated infrastructure provisioning/read, application registration, Portal-safe infrastructure projection, and identity capability execution. It derives actors solely from Bearer TrustID assertions through the canonical verifier, rejects unknown credentialed origins, supports strict preflight, does not use wildcard credentialed CORS, and returns stable safe errors.

The service remains production-verification blocked: the local PostgreSQL daemon is unavailable, so neither migration application nor the mandatory PostgreSQL restart proof could be exercised. A live TrustID assertion also requires an interactive authenticated ceremony and was not fabricated. Digi Authority runtime consumption remains an integration requirement for consequential capability execution; no alternate authority system was added. Nothing is deployed.
