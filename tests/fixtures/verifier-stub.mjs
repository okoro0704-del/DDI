export async function verifyAuthority(input) {
  if (input.token === "mismatch") return { ok: false, reason: "wrong_owner" };
  if (input.token === "allow") return { ok: true, claims: { sub: "own_from_digi" } };
  return { ok: false, reason: "malformed_token" };
}
