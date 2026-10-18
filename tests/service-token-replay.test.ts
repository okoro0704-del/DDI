import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pool } from "pg";
import { migrate } from "../packages/service/src/postgres.ts";
import { PostgresReplayStore, ServiceReplayUnavailable, ServiceTokenVerifier } from "../packages/service/src/service-token.ts";
import { testServiceIdentity } from "./helpers/service-keys.ts";

const databaseUrl = process.env.DDI_TEST_DATABASE_URL ?? "";
const schema = "ddi_service_replay";
const md = testServiceIdentity("master-distributor");
const request = { method: "POST", path: "/internal/downloads/redeem" };

describe("D3C-C shared service-token replay protection (PostgreSQL)", { concurrency: 1 }, () => {
  const pools: Pool[] = [];
  const open = () => { const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` }); pools.push(pool); return pool; };
  // Each "instance" has its own pool and verifier; they share only the database.
  const instance = (pool = open()) => new ServiceTokenVerifier({ audience: "ddi", services: { "master-distributor": md.trusted(["downloads:redeem"]) }, replay: new PostgresReplayStore(pool, "ddi_service_token_replay") });

  before(async () => {
    if (!databaseUrl || !["127.0.0.1", "localhost", "::1"].includes(new URL(databaseUrl).hostname)) throw new Error("local disposable DDI_TEST_DATABASE_URL required");
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    await migrate(open(), join("migrations", "009_service_token_replay.sql"));
  });
  after(async () => { for (const pool of pools) await pool.end().catch(() => undefined); });

  test("a token is accepted once; repeats on the same or another instance are refused", async () => {
    const a = instance();
    const b = instance();
    const token = md.token("ddi", "POST", "/internal/downloads/redeem");
    assert.ok(await a.verify(token, request));
    assert.equal(await a.verify(token, request), null);
    assert.equal(await b.verify(token, request), null);
  });

  test("simultaneous use across eight instances admits exactly one", async () => {
    for (let round = 0; round < 5; round++) {
      const token = md.token("ddi", "POST", "/internal/downloads/redeem");
      const verifiers = Array.from({ length: 8 }, () => instance());
      const results = await Promise.all(verifiers.map(v => v.verify(token, request)));
      assert.equal(results.filter(Boolean).length, 1, `round ${round}`);
    }
  });

  test("replay protection survives a service restart", async () => {
    const token = md.token("ddi", "POST", "/internal/downloads/redeem");
    const first = open();
    assert.ok(await instance(first).verify(token, request));
    await first.end();
    pools.splice(pools.indexOf(first), 1);
    assert.equal(await instance().verify(token, request), null, "a fresh process still refuses it");
  });

  test("an unavailable store fails closed instead of skipping the check", async () => {
    const broken = open();
    const verifier = instance(broken);
    await broken.end();
    pools.splice(pools.indexOf(broken), 1);
    await assert.rejects(verifier.verify(md.token("ddi", "POST", "/internal/downloads/redeem"), request), ServiceReplayUnavailable);
    // Tokens that fail authentication never reach (or occupy) the store.
    assert.equal(await verifier.verify("not.a.token", request), null);
  });

  test("records hold no token material and are purged only after the token has expired", async () => {
    const pool = open();
    const token = md.token("ddi", "POST", "/internal/downloads/redeem");
    assert.ok(await instance(pool).verify(token, request));
    const rows = await pool.query<{ row: string }>(`SELECT row_to_json(r)::text AS row FROM ddi_service_token_replay r`);
    const jti = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).jti as string;
    for (const { row } of rows.rows) { assert.equal(row.includes(token), false); assert.equal(row.includes(jti), false); }
    await pool.query(`INSERT INTO ddi_service_token_replay (jti_hash, issuer, expires_at) VALUES ('expired-row', 'x', now() - interval '10 minutes')`);
    const store = new PostgresReplayStore(pool, "ddi_service_token_replay");
    await store.consume("master-distributor", "trigger-purge", Math.floor(Date.now() / 1000) + 60);
    const left = await pool.query<{ jti_hash: string }>(`SELECT jti_hash FROM ddi_service_token_replay`);
    assert.equal(left.rows.some(r => r.jti_hash === "expired-row"), false, "expired row purged");
    assert.ok(left.rowCount! >= 2, "unexpired rows retained");
  });
});
