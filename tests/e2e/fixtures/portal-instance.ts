/**
 * D3D-A acceptance fixture: one real LifeOS Portal process (remote install mode, PostgreSQL store and
 * install claims) that the crash-recovery suite can start, kill and restart.
 *
 * Started by tests/e2e/d3da-crash-recovery.e2e.ts as `node --import tsx <this file>` with the Portal
 * checkout as working directory. Protocol on stdout, one line each:
 *   SESSION <owner> <portal-session-token>   a Portal session for each owner in PORTAL_OWNERS
 *   READY <base-url>                         listening (the parent then polls GET /health)
 *   BARRIER <tenant-id>                      PORTAL_BARRIER=1: MD succeeded, the Portal has not yet
 *                                            recorded it; the process waits here until it is killed
 *   BARRIER_COMMIT                           PORTAL_BARRIER=commit (D3D-B1): the ready install is durable,
 *                                            the install claim is not yet committed; waits until killed
 */
import { createPrivateKey } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const PORTAL_ROOT = env("PORTAL_ROOT");
const databaseUrl = env("PORTAL_E2E_DATABASE_URL");
const local = (url: string) => ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname);
for (const url of [databaseUrl, env("PORTAL_MD_URL"), env("PORTAL_MYBRANDOS_URL")]) if (!local(url)) throw new Error("the Portal fixture only talks to local services");

// Portal configuration is read at import time.
Object.assign(process.env, { NODE_ENV: "test", INSTALL_MODE: "remote", MASTER_DISTRIBUTOR_URL: env("PORTAL_MD_URL"), MYBRANDOS_URL: env("PORTAL_MYBRANDOS_URL"), MYBRANDOS_WHITE_LABEL_SECRET: "e2e-mybrand-double" });
const importFrom = (rel: string) => import(pathToFileURL(join(PORTAL_ROOT, rel)).href);
const { openStore } = await importFrom("/apps/portal-api/src/store/open.ts");
const { buildApp } = await importFrom("/apps/portal-api/src/app.ts");
const { issuePortalSession } = await importFrom("/apps/portal-api/src/lib/auth.ts");
const { createRemoteDistributor } = await importFrom("/apps/portal-api/src/services/distributor.ts");
const { PostgresInstallClaimStore, postgresReadyInstallLookup } = await importFrom("/apps/portal-api/src/services/install-claims.ts");

const signer = { serviceId: "lifeos-portal", keyId: env("PORTAL_KEY_ID"), privateKey: createPrivateKey(env("PORTAL_PRIVATE_KEY_PEM")) };
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const store = await openStore({ databaseUrl });
const hang = () => new Promise<never>(() => undefined);
const distributor = createRemoteDistributor({
  signer,
  installClaims: new PostgresInstallClaimStore(pool),
  installLeaseMs: Number(env("PORTAL_INSTALL_LEASE_MS")),
  afterBootstrap: process.env.PORTAL_BARRIER === "1"
    ? async (result: { tenantId: string }) => {
        process.stdout.write(`BARRIER ${result.tenantId}\n`);
        await hang();
      }
    : undefined,
  readyInstalls: postgresReadyInstallLookup(pool),
  beforeCommit: process.env.PORTAL_BARRIER === "commit"
    ? async () => {
        process.stdout.write("BARRIER_COMMIT\n");
        await hang();
      }
    : undefined,
});
const app = await buildApp({ store, distributor, ddiIntegration: { trustedServices: {}, signer, productMap: {}, production: false, databaseUrl, masterDistributorAudience: "master-distributor" } });
for (const owner of (process.env.PORTAL_OWNERS ?? "").split(",").filter(Boolean)) {
  const user = store.getUserByTrustId(`TD-${owner}`) ?? store.upsertUser({ trustId: `TD-${owner}`, displayName: owner, trustTier: null, identityStatus: null });
  const { rawToken } = await issuePortalSession(store, user);
  process.stdout.write(`SESSION ${owner} ${rawToken}\n`);
}
await store.flush();
process.stdout.write(`READY ${await app.listen({ port: 0, host: "127.0.0.1" })}\n`);
