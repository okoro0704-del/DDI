import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("production runtime does not keep a JSON kernel or read Digi tables", async () => {
  const files = ["packages/service/src/runtime.ts", "packages/service/src/v11.ts", "packages/service/src/postgres-repository.ts", "apps/api/src/compose.ts", "apps/api/src/app.ts"];
  const source = (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n");
  assert.equal(source.includes("JsonTestStore"), false);
  assert.equal(source.includes("identityCurrentActor"), false);
  assert.equal(source.includes("ownerSubject"), false);
  for (const table of ["digi_owners", "external_identities", "digi_sessions"]) assert.equal(source.includes(table), false);
});
