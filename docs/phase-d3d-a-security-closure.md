# Phase D3D-A — security closure and CI trust root

Local preparation only. Nothing in this phase was pushed, merged or deployed; no GitHub ruleset,
Actions policy or repository setting was changed; no secret value was read or reproduced.
Every setting below is a separate approval.

## 1. Recovery evidence

The D3D-A recovery report found 121 unreachable objects in the DDI repository (35 snapshot trees,
their 31 subtrees and 55 blobs; no commits). They are now protected from garbage collection by
41 local refs under `refs/recovery/d3da-20261017/` (`snapshot/<time>-<tree>` and
`blob/<time>-<blob>-<label>`); `git fsck --unreachable --no-reflogs` reports nothing. These refs
are not pushed by a normal `git push`. The newest snapshot (2026-10-13 21:48) was already protected
by its `refs/codex/...` checkpoint. `DDI-git-recovery-backup`, `DDI-Recovered-Verified` (the
authoritative copy of snapshot `310c4868d7`) and `DDI-Recovered-Evidence` (a lossy copy: byte-order
marks stripped, binaries corrupted; do not use) are untouched.

## 2. CI trust root

### 2.1 Verified GitHub behaviour

| Fact | Source |
| --- | --- |
| Since 2025-12-08, `pull_request_target` always takes the workflow file and checkout commit from the **default branch**; `GITHUB_REF`/`GITHUB_SHA` are the default branch. | [Changelog 2025-11-07](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/) |
| Public repositories without an applicable Actions event policy get a default policy that **blocks `pull_request_target`**, enforced on **2026-11-02**; blocked runs fail. A repository policy can allow it, scoped to workflow paths. | [Changelog 2026-09-17](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/), [Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), [Policies REST API](https://docs.github.com/en/rest/actions/policies) |
| `actions/checkout` v7 (and the floating `@v4` tag) refuses fork pull-request code in `pull_request_target` unless `allow-unsafe-pr-checkout` is set; SHA-pinned v4.2.2 is unchanged. | [Changelog 2026-06-18](https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout/) |
| Checking out pull-request code in `pull_request_target` is acceptable only if it "is only ever inspected as data and never executed". | [Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target) |
| Required checks can name an expected source app; skipped (path-filtered) workflows leave required checks pending. Rulesets' "require workflows" is an organization/enterprise rule; this repository is user-owned. | [Troubleshooting required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), [Available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) |

Observed on this repository (read-only API): public, user-owned, default branch `master`, no
rulesets, no branch protection, no Actions policies, default workflow token `read`, all actions
allowed, SHA pinning not required, fork approval for first-time contributors. The trusted review
has never run: on PR #4 its file was on the base branch, not on the default branch.

### 2.2 Design (implemented locally)

- **One trust root.** The trusted review (`.github/workflows/ci-safety-gate.yml`) runs from the
  default branch because GitHub requires it; the acceptance job's runtime gate now checks out its
  trusted copy from the default branch as well (`${{ github.event.repository.default_branch }}`).
  Protecting `master` protects every gate.
- **Untrusted code never runs with privilege.** The trusted job checks out only `/.github/workflows/`
  of the pull request and of its base (non-cone sparse checkout), reads them as data with the
  repository's own strict parser, executes nothing from them, has `contents: read`, persists no
  credentials, references no secrets and uses no cache. The job that runs pull-request code
  (`d3-cross-repo-acceptance.yml`) is `pull_request` only, read-only, secret-free and gated.
- **No PR can bypass checks by changing its own workflow.** The review runs from `master`, so a PR
  cannot edit it; every PR-triggerable workflow must start with the runtime gate; a PR may not
  remove a required workflow its base has, nor remove or alter the trusted review; and no workflow
  in a PR (any trigger) may publish a check named like `ddi-trusted-ci-review` (compared case- and
  whitespace-insensitively), compute a job name, or grant `checks`/`statuses` write (read from the
  parsed workflow and every job, so quoted or folded values count).
- **Compatible with branches that predate the gate.** `--require` and `--self` are judged against
  the PR's base, so the existing drafts can merge in order (2.3).
- **Pinned.** Every `uses:` is a full commit SHA; sibling repositories and the PostgreSQL image are
  pinned; `master`'s push workflow gains `contents: read` and pinned actions.

### 2.3 Exact pull-request sequence

Simulated locally with the new trusted gate against each head and base (section 6).

| # | Pull request | Head | Base | Trusted review |
| --- | --- | --- | --- | --- |
| 1 | **New** "CI trust root" from `bootstrap/ddi-ci-trust-root-master-v2` | `8abde03` (= `6cf8589` + two corrections) | `master` | not yet active (human review only) |
| 2 | Approve and create the Actions policies (3.1) before 2026-11-02, then the `master` ruleset (3.2) | — | — | — |
| 3 | Existing **#1** D3C | `b7c3def` | `pdi-communication-v1-ci-verify` | passes |
| 4 | **New** "D3D-A + D3D-B1 + security closure" from `feature/ddi-d3d-a-security-closure` | this branch | `pdi-communication-v1-ci-verify` (after 3) | passes |
| 5 | Close #2, #3, #4 as superseded by step 4 (their commits are included), and #5 as superseded by step 1. No branch is deleted. | — | — | — |
| 6 | Apply the `pdi` ruleset; then require SHA pinning and restrict allowed actions (3.3) | — | — | — |
| 7 | Later: `pdi-communication-v1-ci-verify` → `master` integration | — | `master` | passes |

Merge with merge commits only, so every reviewed SHA (and every pin) stays reachable. Do not merge
#2 alone or #3 without the closure commits: the new gate refuses both (old trust-root reference),
and #5 differs from the trusted copy.

### 2.4 Residual risks

- Same-repository branch pushes can run any push workflow on a PR's head commit; check integrity
  blocks name collisions and `checks`/`statuses` write, and only the owner can push branches.
- The `pull_request_target` allow-policy must exist before 2026-11-02, or the trusted review fails.
- Upgrading `actions/checkout` to v7 in the trusted job requires `allow-unsafe-pr-checkout: true`
  on the two data-only checkouts, as a deliberate, reviewed decision.
- A required check on a path-filtered workflow would stay pending, so `acceptance` is not required.

## 3. Settings to apply after approval (prepared, not applied)

### 3.1 Actions policies (`docs/ci/actions-policies/`)

```bash
gh api -X POST -H "X-GitHub-Api-Version: 2026-03-10" repos/okoro0704-del/DDI/actions/policies --input docs/ci/actions-policies/01-trusted-review-pull-request-target.json
gh api -X POST -H "X-GitHub-Api-Version: 2026-03-10" repos/okoro0704-del/DDI/actions/policies --input docs/ci/actions-policies/02-other-workflows.json
```

Policy 1 allows only `pull_request_target`, only for `.github/workflows/ci-safety-gate.yml`.
Policy 2 allows `push`, `pull_request` and `workflow_dispatch` for every other workflow. The two
target disjoint paths, so the result does not depend on how GitHub combines policies. Evaluate mode
is Enterprise-only; apply when a test PR can confirm the review still runs.

### 3.2 Rulesets (`docs/ci/rulesets/`)

```bash
gh api -X POST repos/okoro0704-del/DDI/rulesets --input docs/ci/rulesets/ddi-master.ruleset.json
gh api -X POST repos/okoro0704-del/DDI/rulesets --input docs/ci/rulesets/ddi-pdi.ruleset.json
```

Both: no deletion, no force push, changes only through pull requests, merge commits only, review
threads resolved, and the `ddi-trusted-ci-review` check from GitHub Actions (app id 15368) on an
up-to-date branch. No bypass actors. **Founder decision still open:** the files use the
single-maintainer setting (0 required approvals); with an independent reviewer set
`required_approving_review_count: 1` and `require_last_push_approval: true` (a sole maintainer
cannot approve their own pull request).

### 3.3 Actions permissions (after step 4 merges)

```bash
gh api -X PUT repos/okoro0704-del/DDI/actions/permissions --input docs/ci/actions-permissions.json
gh api -X PUT repos/okoro0704-del/DDI/actions/permissions/selected-actions --input docs/ci/actions-selected.json
```

Requires SHA pinning and allows only GitHub-owned actions (DDI uses `actions/checkout` and
`actions/setup-node`). Before step 4, `pdi-communication-v1-ci-verify` still has tag-pinned actions
and would fail its push runs.

## 4. Cross-service authentication containment

### 4.1 Findings (values never read or reproduced)

| Service | Where (pinned commit) | Mechanism | Fallback when unset | Production refusal |
| --- | --- | --- | --- | --- |
| TrustID → ElfCom | TRUSTID `apps/api/src/lib/config.ts` (`8bf7852`), minted in `apps/api/src/modules/elfcom/capability.ts` | HS256 capability JWT, iss `lifeos`, aud `elfcom`, 300 s | committed literal for `ELFCOM_CAPABILITY_JWT_SECRET` / `LIFEOS_JWT_SECRET` / `ELFCOM_NODE_SECRET` | none |
| ElfCom | elfCOM `apps/elfcom-node/src/config.ts` (`f0b7e72`, still on `origin/main` `7f51b5d`), verified in `src/auth/node-jwt.ts`; also session-key derivation | HS256, issuer/audience checked, algorithm not pinned | committed literal for `LIFEOS_JWT_SECRET` — **the same value as TrustID's** (compared locally, not reproduced) | none |
| Platform Jobs, Distribution Hub | platformjob `platform-jobs-engine/src/auth/trust-id.ts`, `apps/distribution-hub/src/config.ts` (`0dbe7d8`) | HS256 (`jsonwebtoken`), tenant from the token's `tenantId` claim | committed literal for `TRUST_ID_JWT_SECRET` | none |
| DataZone | DataZone `services/data-zone/src/middleware/{auth,baas-auth}.ts`, `sovereign-drive-engine/src/middleware/auth.ts` (`5814c16`) | HS256, issuer/audience checked; also mints HS256 media tokens | committed literal for `TRUST_ID_JWT_SECRET` | none |
| TrustID BaaS SDK | `packages/baas-sdk/src/{master-distribution,platform-job,datazone}.ts` | mints HS256 with caller-supplied secret, self-asserted roles/tenant | — | — |

If a deployment leaves the variable unset, anyone can mint tokens the service accepts. Whether
production sets them is **unverified** (production configuration was not inspected).

### 4.2 DDI-owned changes (implemented)

- DDI has no HS256 verification and no fallback secrets; its service tokens are Ed25519 with pinned
  keys and replay protection, and its TrustID assertions are verified through TrustID's bridge with
  issuer, audience and JWKS required in production.
- The communication-binding suite no longer embeds ElfCom's committed fallback or relies on it: it
  passes a per-run `LIFEOS_JWT_SECRET` to the ElfCom process. This keeps DDI's CI working when ElfCom
  removes the fallback.
- `ELFCOM_BASE_URL`/`ELFCOM_PDI_SERVICE_TOKEN` are read through `readConfig`; the URL must be http(s)
  without credentials, query or fragment, and https in production except loopback and
  `*.railway.internal`. Unset still means the communication primitive is unavailable. Compatibility:
  a production deployment using plain http to a public host would now refuse to start; confirm the
  deployed value's form (not the token) before deploying.

### 4.3 Deployed consumers to confirm before removing compatibility

From code (production not inspected): TrustID API (mints ElfCom capability tokens; carries the
BaaS SDK), LifeOS (`scripts/deploy-distribution.ts` and its LifeOS HTTP ElfCom adapter), ElfCom
console sessions, DataZone media links, and any service holding `TRUST_ID_JWT_SECRET`. An operator
must list which deployed services set each variable (names only, never values) before step C below.

### 4.4 Asymmetric TrustID-issued credentials (plan)

Target: every cross-service token is a TrustID-issued JWS with `alg` pinned to `EdDSA` (Ed25519),
`kid` resolved only from TrustID's JWKS for that issuer, exact `iss`, per-service `aud`, `typ`
pinned, lifetime ≤ 300 s, `jti` single-use where replay matters, and permissions mapped by the
verifier, never taken from claims. DDI, Portal and Master Distributor already verify this shape for
service identity (`digiconomy-service+jwt`); person-bound capabilities use TrustID assertions via
the authority verifier.

- **A. Contain now:** each service refuses to start in production when its HMAC secret is unset,
  shorter than 32 bytes or equal to a known published value; algorithms pinned to `["HS256"]`;
  issuer and audience mandatory. No compatibility loss for correctly configured deployments.
- **B. Dual-accept:** verifiers accept TrustID EdDSA tokens alongside HS256, log every HS256 use
  (caller, never token), and callers switch to EdDSA one by one.
- **C. Enforce:** only after the consumer list (4.3) shows no HS256 caller, reject HS256 and delete
  the shared secrets. Rotate only under a separate approval.

Instructions for each repository's own workspace: `docs/remediation/`.

## 5. Architecture preservation

Confirmed in code and tests (unchanged by this phase; it touches only CI, configuration
validation, one test fixture and docs):

- **One owner, one PDI:** partial unique index `ddi_personal_owner_uidx`; tests "one owner keeps one
  PDI across a brand and ten businesses", "many activations keep one Personal PDI, including
  concurrent first activations", "no duplicate PDI ... after recovery".
- **Business connections stay independent:** one connection per application, approved capabilities
  per connection, property-scoped grants bound to actor, action, resource and audience
  (`AUTHORITY_BINDING_MISMATCH`), revoked properties denied before and after execution.
- **PDI ownership grants no financial authority:** `value.*` routes to an unavailable FundzMan
  adapter; every execution also needs an approved connection and a consumed Digi Authority grant.
- **Primitives stay independent:** one adapter per namespace; DDI coordinates access only.

## 6. Verification (local)

- Typecheck clean. Database-free DDI suites pass (api 9, commercial-units 5, foundation 18,
  ownership-verification 2, service-token 4, v11-durability 1); CI gate 35/35 (25 existing, 10 new).
- Activation pre-flight: a 17-case impersonation matrix (job id/name collisions in any case or
  padding, computed names, matrix and reusable jobs, plain/quoted/folded `checks`/`statuses` write and
  `write-all`) is refused, with an ordinary workflow as control; the non-cone pattern materialises only
  `.github/workflows/`.
- Mutation checks: making `--require` unconditional, dropping check integrity, reverting the trust
  root, accepting a missing trusted review everywhere, and allowing production http each fail tests.
- Trusted-review simulation: the new sequence passes; old #2, #3 (without closure) and #5 heads, a
  PR removing the trusted review and a workflow publishing `ddi-trusted-ci-review` are refused.
- PostgreSQL suites and the cross-repository acceptance job need PostgreSQL and run in CI after
  the push approval.
