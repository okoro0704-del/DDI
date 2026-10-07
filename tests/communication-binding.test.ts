import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createSecretKey, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Pool } from "pg";
import { SignJWT } from "jose";
import type { Actor, CapabilityRequest } from "../packages/contracts/src/index.ts";
import { ElfComAdapter, communicationBindingReference, type AuthorityVerifier } from "../packages/core/src/index.ts";
import { routeInventory } from "../apps/api/src/app.ts";
import { migrate } from "../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../packages/service/src/postgres-repository.ts";
import { DurableDdiService, defaultAdapters } from "../packages/service/src/runtime.ts";

const databaseUrl = process.env.DDI_TEST_DATABASE_URL ?? "";
const SCHEMA = "ddi_communication_binding";
const ELFCOM = "C:/Users/Hp/Desktop/ELFCOMS/apps/elfcom-node";
const PORT = 18792;
const SERVICE_TOKEN = "ddi-communication-proof-token";
const BASE = `http://127.0.0.1:${PORT}`;

function assertLocal(url: string) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("DDI Postgres tests only run against a local disposable database");
}

describe("PDI communication primitive binding", { concurrency: 1 }, () => {
  let pool: Pool;
  let repository: PostgresDdiRepository;
  let elfcom: ChildProcess;
  const grants = { async ensureGrant() { return { grantId: `auth_${randomUUID()}` }; }, async revokeGrant() { return undefined; } };
  const allow: AuthorityVerifier = async () => ({ ok: true, grantId: "auth_exec" });

  before(async () => {
    if (!databaseUrl) throw new Error("DDI_TEST_DATABASE_URL_REQUIRED");
    assertLocal(databaseUrl);
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", ELFCOM_PORT: String(PORT), ELFCOM_PDI_SERVICE_TOKEN: SERVICE_TOKEN };
    delete env.DATABASE_URL;
    elfcom = spawn(process.execPath, ["C:/Users/Hp/Desktop/ELFCOMS/node_modules/tsx/dist/cli.mjs", "src/index.ts"], { cwd: ELFCOM, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    elfcom.stdout?.on("data", (chunk) => { log += String(chunk); });
    elfcom.stderr?.on("data", (chunk) => { log += String(chunk); });
    const started = Date.now();
    while (!log.includes("listening") && Date.now() - started < 60000) {
      if (elfcom.exitCode !== null) throw new Error(log.slice(-1000));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!log.includes("listening")) throw new Error(log.slice(-1000));
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000, options: `-c search_path=${SCHEMA}` });
    await migrate(pool, join("migrations", "001_ddi_foundation.sql"));
    await migrate(pool, join("migrations", "002_ddi_runtime.sql"));
    await migrate(pool, join("migrations", "003_pdi_connections.sql"));
    repository = new PostgresDdiRepository(pool);
    process.env.ELFCOM_BASE_URL = BASE;
    process.env.ELFCOM_PDI_SERVICE_TOKEN = SERVICE_TOKEN;
  });

  after(async () => {
    if (elfcom?.pid) spawn("taskkill", ["/PID", String(elfcom.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
    await pool?.end();
  });

  function service(authority: AuthorityVerifier = allow, adapters = defaultAdapters(async () => ({ subject: "unused-subject" }), { baseUrl: BASE, serviceToken: SERVICE_TOKEN })) {
    return new DurableDdiService(repository, authority, adapters, undefined, grants);
  }
  function actor(ownerId: string): Actor {
    return { ownerId: ownerId as Actor["ownerId"], kind: "HUMAN", verified: true };
  }
  async function ready(ownerId: string, key: string, capabilities: CapabilityRequest["capability"][] = ["identity.currentActor", "communication.inbox"]) {
    const current = actor(ownerId);
    const infra = await repository.provision(current.ownerId, { type: "PERSONAL", idempotencyKey: key });
    const app = await repository.registerApplication(current.ownerId, infra.id, { type: "REFERENCE", displayName: "HospitalityOS", capabilities, idempotencyKey: `${key}-app` });
    return { current, infra, app };
  }
  function request(item: { infra: { id: string; ownerId: Actor["ownerId"] }; app: { id: string } }, mode: "APP" | "SPACE", capability: CapabilityRequest["capability"], payload?: unknown): CapabilityRequest {
    return { infrastructureId: item.infra.id as CapabilityRequest["infrastructureId"], applicationId: item.app.id as CapabilityRequest["applicationId"], capability, action: capability, resource: `ddi:pdi:${item.infra.id}:${capability}`, audience: "ddi", actor: { ownerId: item.infra.ownerId, kind: "SERVICE", verified: true, authorityActor: `app:${item.app.id}` }, authority: { token: "authority-token" }, correlationId: randomUUID(), executionMode: mode, payload };
  }
  async function activate(item: Awaited<ReturnType<typeof ready>>, capabilities: CapabilityRequest["capability"][], key: string) {
    const connection = await repository.requestConnection(item.app.id, capabilities, key, key);
    await repository.approveConnection(item.current.ownerId, connection.id, capabilities, key, grants);
    return connection;
  }
  test("explicit personal creation provisions one system-managed ElfCom binding and does not open a product connection", async () => {
    assert.equal(routeInventory.some(route => route.url.includes("bind")), false);
    const item = await ready("own_comm_new", "comm-new");
    const rows = await pool.query<{ n: string; provider: string; provider_reference: string }>(`SELECT count(*)::text AS n, max(provider) AS provider, max(provider_reference) AS provider_reference FROM ddi_primitive_bindings WHERE infrastructure_id = $1 AND namespace = 'communication'`, [item.infra.id]);
    assert.equal(Number(rows.rows[0]?.n), 1);
    assert.equal(rows.rows[0]?.provider, "ElfCom");
    assert.equal(rows.rows[0]?.provider_reference, communicationBindingReference("own_comm_new"));
    assert.equal((await repository.findBinding(item.infra.id, "communication"))?.management, "SYSTEM_MANAGED");
    assert.equal((await repository.listConnections(item.infra.id)).length, 0);
    const again = await repository.provision(item.current.ownerId, { type: "PERSONAL", idempotencyKey: "comm-new-repeat" });
    assert.equal(again.id, item.infra.id);
    const repeated = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ddi_primitive_bindings WHERE infrastructure_id = $1 AND namespace = 'communication'`, [item.infra.id]);
    assert.equal(Number(repeated.rows[0]?.n), 1);
    await assert.rejects(repository.bind(item.current.ownerId, item.infra.id, "communication", "TrustID"), /PROVIDER_LOCKED|PROVIDER_CONFLICT/);
    const creator = await repository.provision(item.current.ownerId, { type: "CREATOR", idempotencyKey: "creator-no-communication" });
    assert.equal(await repository.findBinding(creator.id, "communication"), null);
  });

  test("inbox follows connection state and stays bound to the same ElfCom account", async () => {
    const item = await ready("own_comm_exec", "comm-exec", ["identity.currentActor", "communication.inbox", "communication.send"]);
    const runtime = service();
    const absent = await runtime.execute(request(item, "APP", "communication.inbox"));
    assert.equal(absent.status, "DENIED");
    assert.equal(absent.reason, "CONNECTION_REQUIRED");
    const requested = await repository.requestConnection(item.app.id, ["identity.currentActor"], "req", "comm-exec-connection");
    const waiting = await runtime.execute(request(item, "APP", "communication.inbox"));
    assert.equal(waiting.reason, "CONNECTION_NOT_ACTIVE");
    await repository.approveConnection(item.current.ownerId, requested.id, ["identity.currentActor"], "identity-approve", grants);
    const unapproved = await runtime.execute(request(item, "APP", "communication.inbox"));
    assert.equal(unapproved.status, "DENIED");
    assert.equal(unapproved.reason, "CAPABILITY_NOT_APPROVED");
    const pending = await repository.requestCapabilityChange(item.app.id, ["communication.inbox"], "comm-change");
    assert.equal(pending.status, "REQUESTED_CHANGE");
    const still = await runtime.execute(request(item, "APP", "communication.inbox"));
    assert.equal(still.reason, "CAPABILITY_NOT_APPROVED");
    await repository.approveConnection(item.current.ownerId, pending.id, ["communication.inbox"], "comm-approve", grants);
    const account = `elfcom:${item.current.ownerId}`;
    const opened = await fetch(new URL("/v1/dm/open", BASE), { method: "POST", headers: { authorization: `Bearer ${await elfcomSession(account)}`, "content-type": "application/json" }, body: JSON.stringify({ peerTrustId: "elfcom:own_comm_peer" }) });
    const openedBody = await opened.text();
    assert.equal(opened.status, 200, openedBody);
    const threadId = (JSON.parse(openedBody) as { thread: { id: string } }).thread.id;
    const completed = await runtime.execute(request(item, "APP", "communication.inbox", { accountRef: "elfcom:own_other", provider: "ElfCom" }));
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.provider, "ElfCom");
    const data = completed.data as { ownerId: string; accountRef: string; threads: Array<{ id: string }> };
    assert.equal(data.ownerId, item.current.ownerId);
    assert.equal(data.accountRef, account);
    assert.equal(data.threads.some(thread => thread.id === threadId), true);
    const space = await runtime.execute(request(item, "SPACE", "communication.inbox"));
    assert.equal((space.data as { accountRef: string; ownerId: string }).ownerId, item.current.ownerId);
    assert.equal((space.data as { accountRef: string }).accountRef, account);
    const bindingId = (await repository.findBinding(item.infra.id, "communication"))?.id;
    await repository.revokeConnection(item.current.ownerId, pending.id, "revoke", grants);
    const revoked = await runtime.execute(request(item, "APP", "communication.inbox"));
    assert.equal(revoked.reason, "CONNECTION_NOT_ACTIVE");
    assert.equal((await repository.findBinding(item.infra.id, "communication"))?.id, bindingId);
    const reconnected = await repository.requestConnection(item.app.id, ["communication.inbox"], "reconnect", "comm-exec-reconnect");
    await repository.approveConnection(item.current.ownerId, reconnected.id, ["communication.inbox"], "reapprove", grants);
    const restored = await runtime.execute(request(item, "SPACE", "communication.inbox"));
    assert.equal(restored.status, "COMPLETED");
    assert.equal((restored.data as { accountRef: string }).accountRef, account);
    assert.equal((await repository.findBinding(item.infra.id, "communication"))?.id, bindingId);
    const sendPending = await repository.requestCapabilityChange(item.app.id, ["communication.send"], "comm-send");
    await repository.approveConnection(item.current.ownerId, sendPending.id, ["communication.send"], "comm-send-approve", grants);
    const malformed = await runtime.execute(request(item, "APP", "communication.send"));
    assert.equal(malformed.status, "FAILED");
    assert.equal(malformed.reason, "INVALID_REQUEST");
  });

  test("identity approval does not authorize communication and both primitives share one owner", async () => {
    const item = await ready("own_comm_multi", "comm-multi");
    const identity = await activate(item, ["identity.currentActor"], "comm-multi-identity");
    const runtime = service();
    const actorResult = await runtime.execute(request(item, "APP", "identity.currentActor"));
    assert.equal(actorResult.provider, "TrustID");
    assert.equal((actorResult.data as { ownerId: string }).ownerId, "own_comm_multi");
    const blocked = await runtime.execute(request(item, "APP", "communication.inbox"));
    assert.equal(blocked.reason, "CAPABILITY_NOT_APPROVED");
    const pending = await repository.requestCapabilityChange(item.app.id, ["communication.inbox"], "comm-multi-change");
    await repository.approveConnection(item.current.ownerId, pending.id, ["communication.inbox"], "comm-multi-approve", grants);
    const inbox = await runtime.execute(request(item, "APP", "communication.inbox"));
    assert.equal(inbox.provider, "ElfCom");
    assert.equal((inbox.data as { ownerId: string }).ownerId, (actorResult.data as { ownerId: string }).ownerId);
    const grantsOnConnection = (await repository.getConnection(identity.id))?.authorityGrantRefs.length;
    assert.equal(grantsOnConnection, 2);
    const bindings = await pool.query<{ namespace: string; provider: string }>(`SELECT namespace, provider FROM ddi_primitive_bindings WHERE infrastructure_id = $1 ORDER BY namespace`, [item.infra.id]);
    assert.deepEqual(bindings.rows, [{ namespace: "communication", provider: "ElfCom" }, { namespace: "identity", provider: "TrustID" }]);
  });

  test("two owners cannot read each other's inbox and a restarted repository keeps the mapping", async () => {
    const left = await ready("own_comm_a", "comm-a");
    const right = await ready("own_comm_b", "comm-b");
    const runtime = service();
    for (const item of [left, right]) await activate(item, ["communication.inbox"], item.infra.id);
    await fetch(new URL("/v1/dm/open", BASE), { method: "POST", headers: { authorization: `Bearer ${await elfcomSession(`elfcom:${left.current.ownerId}`)}`, "content-type": "application/json" }, body: JSON.stringify({ peerTrustId: "elfcom:peer-left" }) });
    const leftResult = await runtime.execute(request(left, "APP", "communication.inbox"));
    const rightResult = await runtime.execute(request(right, "APP", "communication.inbox"));
    assert.equal((leftResult.data as { ownerId: string }).ownerId, "own_comm_a");
    assert.equal((rightResult.data as { ownerId: string }).ownerId, "own_comm_b");
    assert.equal((leftResult.data as { threads: unknown[] }).threads.length > 0, true);
    assert.equal((rightResult.data as { threads: unknown[] }).threads.length, 0);
    const crossed = await runtime.execute({ ...request(left, "APP", "communication.inbox"), actor: { ownerId: right.current.ownerId, kind: "SERVICE", verified: true } });
    assert.equal(crossed.reason, "OWNER_MISMATCH");
    await pool.query(`UPDATE ddi_primitive_bindings SET provider_reference = $2 WHERE infrastructure_id = $1 AND namespace = 'communication'`, [left.infra.id, communicationBindingReference("own_comm_b")]);
    const tampered = await runtime.execute(request(left, "APP", "communication.inbox"));
    assert.equal(tampered.status, "DENIED");
    assert.equal(tampered.reason, "OWNER_MISMATCH");
    await pool.query(`UPDATE ddi_primitive_bindings SET provider_reference = NULL WHERE infrastructure_id = $1 AND namespace = 'communication'`, [right.infra.id]);
    const missing = await runtime.execute(request(right, "APP", "communication.inbox"));
    assert.equal(missing.reason, "PROVIDER_NOT_CONFIGURED");
    const restartedPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, options: `-c search_path=${SCHEMA}` });
    const restarted = new PostgresDdiRepository(restartedPool);
    const binding = await restarted.findBinding(left.infra.id, "communication");
    assert.equal(binding?.provider, "ElfCom");
    assert.equal(binding?.reference, communicationBindingReference("own_comm_b"));
    await pool.query(`UPDATE ddi_primitive_bindings SET provider_reference = $2 WHERE infrastructure_id = $1 AND namespace = 'communication'`, [left.infra.id, communicationBindingReference("own_comm_a")]);
    const restartedService = new DurableDdiService(restarted, allow, defaultAdapters(async () => null, { baseUrl: BASE, serviceToken: SERVICE_TOKEN }), undefined, grants);
    const afterRestart = await restartedService.execute(request(left, "SPACE", "communication.inbox"));
    assert.equal((afterRestart.data as { ownerId: string; accountRef: string }).ownerId, "own_comm_a");
    assert.equal((afterRestart.data as { accountRef: string }).accountRef, "elfcom:own_comm_a");
    await restartedPool.end();
  });

  test("an unavailable ElfCom provider does not invent an inbox", async () => {
    const item = await ready("own_comm_down", "comm-down");
    await activate(item, ["communication.inbox"], "comm-down-connection");
    const adapters = defaultAdapters(async () => null, { baseUrl: "http://127.0.0.1:1", serviceToken: SERVICE_TOKEN });
    const result = await service(allow, adapters).execute(request(item, "APP", "communication.inbox"));
    assert.equal(result.status, "CAPABILITY_UNAVAILABLE");
    assert.equal(result.reason, "PROVIDER_UNAVAILABLE");
    assert.equal(result.data, undefined);
    const unconfigured = new Map(adapters);
    unconfigured.set("communication", new ElfComAdapter());
    const closed = await service(allow, unconfigured).execute(request(item, "APP", "communication.inbox"));
    assert.equal(closed.reason, "PROVIDER_UNAVAILABLE");
  });
});

async function elfcomSession(owner: string) {
  const secret = "elfcom-dev-node-secret-change-me";
  const sid = `proof:${owner}`;
  const specifier = "file:///C:/Users/Hp/Desktop/ELFCOMS/packages/elfcom-crypto/dist/index.js";
  const crypto = await import(specifier) as { computeZkBind(key: Buffer, fields: { aud: string; sid: string; ownerTrustId: string }): string; derivePhaseASessionKey(secret: string, owner: string, sid: string): Buffer };
  const sessionKey = crypto.derivePhaseASessionKey(secret, owner, sid);
  const zk_bind = crypto.computeZkBind(sessionKey, { aud: "elfcom", sid, ownerTrustId: owner });
  const token = await new SignJWT({ sid, zk_bind, scp: ["thread:read", "thread:write", "message:send", "session:bind"] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("lifeos")
    .setAudience("elfcom")
    .setSubject(owner)
    .setExpirationTime("5m")
    .sign(createSecretKey(Buffer.from(secret, "utf8")));
  const bound = await fetch(new URL("/v1/session/bind", BASE), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ sid, ownerTrustId: owner, zk_bind, sessionKeyBase64: sessionKey.toString("base64") }) });
  if (bound.status !== 204) throw new Error(`ELFCOM_BIND_${bound.status}`);
  return token;
}
