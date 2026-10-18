# Stages 5C–5D — private-repository acceptance on GitHub Free

Local preparation only. Nothing in these stages created a credential, a GitHub App, a repository,
an environment or a secret; changed visibility, a ruleset or an Actions setting; pushed, merged or
touched LifeOS Portal. Every setting in §7 needs separate approval. PR #11 (`pdi` → `master`) stays
NO-GO until §8 has run on its exact merge tree.

## 1. Why acceptance stopped

LifeOS Portal (`okoro0704-del/LifeOS-Portal`) became private on 2026-10-18 (08:18:54Z); anonymous
reads now return 404. DDI's pull-request jobs hold no credential, so the D3 cross-repository
acceptance failed at the Portal checkout, before any suite ran. Master Distributor, TrustID and
ElfCom are still public.

## 2. GitHub Free capabilities (verified 2026-10-18)

| Capability | Free, private repository | Evidence |
| --- | --- | --- |
| Repository Actions secrets | Available. Not scoped by branch, job or environment; any workflow that references one gets it. Organization secrets are not available to private repositories on Free (irrelevant here: the account is a user). | [Using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) |
| Environment secrets | Not available. "Users with GitHub Free plans can only configure environments for public repositories"; after a repository goes private, its environment secrets "will be ignored". | [Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) |
| Environment branch restrictions | Not available ("For users on GitHub Pro or GitHub Team plans, deployment branches and tags are also available for private repositories"). | [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) |
| Required reviewers (environments) | Not available ("only available for public repositories" on Free, Pro and Team). | Same page |
| Repository rulesets and branch protection | Not available. LifeOS-Portal's API answers "Upgrade to GitHub Pro or make this repository public to enable this feature." GitHub's plan page lists protected branches for private repositories under Pro. Organization rulesets do not apply (user account). | Observed API response; [GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) |
| GitHub Apps | Available to personal accounts. Only GitHub Apps can create check runs ("OAuth apps and authenticated users … are not able to create them"). Installation tokens can be narrowed to one repository and one permission per request. | [Check runs API](https://docs.github.com/en/rest/checks/runs), `actions/create-github-app-token` v2.1.1 inputs |
| Required status checks | Available on DDI because DDI is public. Already enforced: rulesets 25324301 (`master`) and 25336320 (`pdi`) require `ddi-trusted-ci-review` from app 15368. A required check can name its app (`integration_id`). | Live rulesets |
| Manual dispatch | "Write access to the repository is required." The file must be on the default branch, but the API and CLI may dispatch it on any ref, so the workflow itself checks the ref. | [Manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) |
| `workflow_run` | Runs only from the default branch's file. It "is able to access secrets and write tokens, even if the previous workflow was not". At most three levels of chaining. | [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) |
| Usage | 2,000 minutes a month and 500 MB of artifact storage. Public repositories are free. Without a payment method, "usage is blocked once you use up your quota". | [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |

### 2.1 What the design relies on, and what it does not

Relied on (documented by GitHub):

- **Per-workflow secret scrubbing.** GitHub "scrubs secrets from memory that are not referenced in
  the workflow". The untrusted workflow references none, so it holds none
  ([Compromised runners](https://docs.github.com/en/actions/concepts/security/compromised-runners)).
- **Per-job tokens.** Each job's `GITHUB_TOKEN` carries that job's permissions; `permissions: {}`
  disables them all ([Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).
- **Fresh VMs.** "Each GitHub-hosted runner is a new virtual machine" (standard runners; single-CPU
  runners share a VM and are not used).
- **App-only check runs.** Check runs can only be created by GitHub Apps, and a ruleset can require
  one from a specific app.
- **Fixed workflow sources.** `workflow_run` runs the default branch's file, and dispatch requires
  write access.

Not relied on, because it is undocumented or unavailable on Free:

- **Job-level secret isolation inside one workflow.** This is why the keys and the candidate are in
  different workflows.
- **Environment secrets, branch policies and required reviewers.** All are unavailable on Free.
- **Branch protection on the runner repository.** Instead, the runner repository has exactly one
  collaborator. Each workflow checks `refs/heads/main` and the triggering maintainer. The report
  requires every run in the chain to come from the same runner commit, the tip of `main`.
- **Artifact immutability.** Every artifact is re-verified against the pinned git tree before use,
  and the reporter consumes no artifact at all.
- **Log masking.** No script names a credential, and nothing traces or dumps the environment.

**No paid control is needed.** GitHub Pro would add environment secrets, a `main`-only deployment
policy and rulesets on the runner repository as defence in depth. It is optional.

## 3. Architecture: three workflows, three trust boundaries

Runner repository: `okoro0704-del/ddi-private-acceptance`, private, one collaborator. Its tree is
exactly `docs/ci/private-acceptance/runner/` in DDI, byte for byte.

| Workflow | Trigger | Credential | Runs | Produces |
| --- | --- | --- | --- | --- |
| `portal-snapshot.yml` | Maintainer dispatch on `main` | Portal reader App key: a token with Contents read, on LifeOS-Portal only, revoked at job end | Checks out the owner-approved ref `refs/tags/ddi-acceptance/316a07b` and verifies the commit is `PORTAL_SHA` with tree `PORTAL_TREE`; `git archive`. No code. | Artifact `portal-source-<PORTAL_SHA>` (tracked files only, 7 days) |
| `ddi-acceptance.yml` | Maintainer dispatch on `main`, with `pr`, `head_sha`, `base`, `base_sha`, `portal_run` | **None.** It references no secret or variable. `resolve` has a contents/actions read token; `acceptance` has `permissions: {}`. | `resolve`, no candidate code: checks the PR, head, base tip, up-to-dateness, runner mirror and pins; checks the snapshot run through GitHub's record; downloads and re-verifies the tree. `acceptance`: credential check, merge-tree re-check, archive digest and tree, then every suite. | Job results only |
| `ddi-report.yml` | `workflow_run`: completion of `DDI private acceptance` | DDI reporter App key: a token with Checks write, on DDI only, minted only after the chain check passes | `scripts/chain.mjs report` on GitHub's records only, then one `gh api` POST | Check run `ddi-private-acceptance` on the DDI head |

The flow:

1. The founder reviews the head.
2. The founder dispatches the snapshot run. It is reusable for 7 days at the same runner commit.
3. The founder dispatches the acceptance run.
4. GitHub starts the report when the acceptance run completes. The report verifies the chain, then
   publishes `success` or `failure`, or publishes nothing.

`scripts/chain.mjs report` publishes nothing unless every one of these holds:

- this is the report's first attempt;
- the completion is of `ddi-acceptance.yml`, dispatched on `main`, from this repository;
- that run used the same runner commit as the report;
- it is the latest attempt, completed, started by a maintainer, and less than 24 hours old;
- its run-name, which GitHub sets from the dispatch inputs, parses exactly and matches GitHub's
  record;
- PR `pr` is open, comes from `okoro0704-del/DDI`, targets `base` and is still at `head`;
- `base_sha` is an ancestor of `head`, and `head` is not behind the current base.

If all of that holds, it reports `success` only when the run, exactly its jobs `resolve` and
`acceptance`, and a valid snapshot run all succeeded. Anything else is reported as `failure`.

## 4. Threat model

| Threat | Controls | Tests |
| --- | --- | --- |
| Candidate reads an App key or a write token | The keys are referenced only in the snapshot and report workflows, which GitHub documents as scrubbed from the acceptance workflow. The candidate job has `permissions: {}`, refuses credential-shaped variables, has no environment and no outputs. | Static: secret, variable or `toJSON(secrets)` in the untrusted workflow; token outputs copied anywhere; write permissions; environment; outputs. Behaviour: credential check. |
| Missing or rejected credential | Token steps cannot be optional, conditioned or reordered. A failed snapshot run is never usable, and the chain reports `failure`. A failed reporter token posts nothing, so the required check stays absent. | Static and chain cases; behaviour: nothing reaches `gh`. |
| Wrong repository | Each token is scoped to one owner, one repository and one permission. Only LifeOS-Portal is fetched with a credential; only public siblings without one. The chain checks the repository of every run and of the PR head. | Static, chain and behaviour cases. |
| Wrong DDI commit | `resolve` requires the PR head to be the reviewed `head_sha` and the base tip to be the reviewed `base_sha`, ancestry, and merge tree equal to head tree. The chain re-checks head, ancestry and current base. | Behaviour and chain cases. |
| Wrong Portal commit | The owner-approved ref must resolve to `PORTAL_SHA` and `PORTAL_TREE`. The artifact is named by `PORTAL_SHA`. Both later verifications re-derive `PORTAL_TREE`. Pins are equal across workflows and to DDI's. | Static, chain and behaviour cases. |
| Artifact substitution | The snapshot artifact must come from a successful maintainer run of the snapshot workflow at this runner commit, the only artifact of that run, unexpired. The in-run copy is downloaded by exact name. Both copies are tree-verified, and the acceptance copy is also digest-verified. The reporter reads no artifact. | Chain cases; behaviour: tampered, re-digested and `.git`-bearing archives. |
| Replay | First report attempt only; latest acceptance attempt only; the runner commit must equal the report's; 24-hour limit; event and record must agree. The result attaches only to the tested head, and the ruleset's strict mode needs a new run for a new head. | Chain cases; static: no manual trigger for the report. |
| Reporter impersonation | Only the reporter App can satisfy the required check (`integration_id`). Its key is referenced by one step of one workflow that cannot be started on request. DDI's gate reserves the name and refuses checks/statuses write in DDI workflows. | Static, chain and gate cases. |
| Unauthorized dispatch | Dispatch needs write access (one collaborator). Every workflow checks `main` and the triggering maintainer. The chain re-checks both actors of both runs. | Static, chain and behaviour cases. |
| Publication on the wrong PR | The PR number, state, base and head must match the run's parameters at report time. Otherwise nothing is published. | Chain and command-line cases. |
| Failure anywhere in the chain | Any non-success run, job or snapshot posts `failure`. Unreadable records post nothing. | Chain and command-line cases. |
| Log, cache or env leakage; drift | No tracing, environment dumps, `GITHUB_ENV`/`GITHUB_PATH`, `/proc` or runner/git/Node overrides. Actions are pinned to allowlisted commits. No cache anywhere. | Static cases. |

## 5. Residual risks

- **Untrusted workflow's secret isolation.** It rests on GitHub's documented per-workflow scrubbing.
  Moving the two credentialed workflows into a second private repository would remove even that
  reliance, at the cost of cross-repository coordination. Not proposed now.
- **Free plan: secrets are not branch-scoped.** Anyone with write access to the runner repository
  could use both keys from a branch. The control is organizational: exactly one collaborator, and no
  deploy keys or other Apps with write access. The in-workflow checks prevent accidents, not a
  malicious maintainer.
- **Candidate sees the Portal source.** That is the purpose of the run, and the maintainer reviews
  the exact head before dispatch. Third-party npm install scripts also run beside it.
- **Reporter key compromise.** A leaked key could post a false `success` until it is rotated.
- **Candidate controls its own tests.** Acceptance proves the reviewed candidate; it does not
  replace review.
- **Run-name handling.** If GitHub ever changed it (for example by truncating), the report would
  publish nothing. That fails closed.
- **Manual operation.** Each acceptance needs a dispatch, and a snapshot run every 7 days or after
  any runner change.

## 6. Minimum App permissions

| App | Installed on | Repository permissions | Token per run | Why not less |
| --- | --- | --- | --- | --- |
| DDI acceptance Portal reader | `okoro0704-del/LifeOS-Portal` only | Contents: Read-only (Metadata: Read-only, mandatory) | `repositories: LifeOS-Portal`, `permission-contents: read` | A checkout needs Contents read |
| DDI acceptance reporter | `okoro0704-del/DDI` only | Checks: Read and write (Metadata: Read-only, mandatory) | `repositories: DDI`, `permission-checks: write` | Creating a check run needs Checks write, and only an App can do it |

Both Apps: owned by `okoro0704-del`, installable only on this account, webhook inactive, no events,
no account permissions. One private key each, stored once and then deleted locally. Reading runs and
artifacts uses each job's own `GITHUB_TOKEN` (`actions: read`), so no App needs Actions permission.

## 7. Settings to apply after approval (prepared, not applied)

Founder:

1. Create `okoro0704-del/ddi-private-acceptance`: private, no collaborators, default branch `main`.
2. Commit the contents of `docs/ci/private-acceptance/runner/`, from an approved DDI commit, at the
   repository root, byte for byte.
3. Runner repository Actions settings:
   - Actions enabled;
   - GitHub-owned actions only, with SHA pinning required;
   - default workflow permissions: read;
   - Actions may not create or approve pull requests.
4. Create and install the reporter App (§6) on DDI. Add the repository variable
   `DDI_REPORTER_APP_ID` and the repository secret `DDI_REPORTER_PRIVATE_KEY` to the runner
   repository.
5. After the first genuine run, add the required check `{"context": "ddi-private-acceptance",
   "integration_id": <reporter App ID>}` to DDI ruleset 25324301 (`master`). Keep
   `ddi-trusted-ci-review`@15368, strict mode and zero bypass actors. Add it to `pdi` (25336320) only
   if every `pdi` pull request should need a private run.

Portal release owner (nothing else in LifeOS-Portal changes):

6. Approve a pin ref: create the tag `ddi-acceptance/316a07b` at
   `316a07b7ad94f5a5eacff790906aa879537439ef`, or name another owner-controlled ref. The snapshot
   checks it out by name and stops if it moves or disappears.
7. Approve the Portal reader App (§6) and its installation on LifeOS-Portal only. The founder then
   adds `PORTAL_READER_APP_ID` (variable) and `PORTAL_READER_PRIVATE_KEY` (secret) to the runner
   repository.

## 8. Acceptance run for PR #11 (after §7)

1. Confirm PR #11 is still at head `5fd550daafcafea92888b8d9ea5668fad0580c44` and `master` at
   `0ed6dd70e40c4bb5f45699cff6a9874d3b6b3ba6`. The merge tree, which equals the head tree, is
   `56a737e42c224e380073ade6726a0a68cc7aa5ce`.
2. PR #11 predates the runner mirror, so `resolve` takes the legacy path. Its
   `d3-cross-repo-acceptance.yml` declares all four pins, and they equal the runner's.
3. Run the Portal snapshot. Then run DDI private acceptance with `pr=11`, `head_sha=5fd550d…`,
   `base=master`, `base_sha=0ed6dd7…` and `portal_run=<snapshot run id>`.
4. Verify the run:
   - every job and suite executed;
   - the check on `5fd550d` comes from the reporter App, with the expected SHAs and pins;
   - no secret appears in the private logs;
   - no other artifacts exist, and nothing was deployed.
5. Spoof checks:
   - a commit status and a GitHub Actions check named `ddi-private-acceptance` must leave a test pull
     request blocked;
   - re-running the report must publish nothing.

## 9. Usage and cost

The last full acceptance job, run 39110643192 (Portal still public), took 3 min 04 s. Per
acceptance, expect about 1 minute for `resolve`, about 4 for `acceptance` and about 1 for the
report. A snapshot takes about 1 minute and is reused for up to 7 days.

If each job is rounded up to a whole minute (GitHub's long-standing practice; the current billing
page does not state it), that is about 7 billed minutes per acceptance. 2,000 included minutes then
cover roughly 250 acceptances a month.

The Portal archive is 0.55 MB: one 7-day snapshot plus a 1-day in-run copy, well under the 500 MB
storage allowance.

Expected cost: $0. With no payment method, an exhausted quota blocks runs. The required check then
stays absent and merges stay blocked, which fails closed.

## 10. Verification (local)

- `node --test tests/private-acceptance.test.ts tests/ci-safety-gate.test.ts`: 80 tests, 80 passing.
  - 38 of them are the CI gate tests, unchanged.
  - The other 42 are the private acceptance tests. They replace the 27 single-workflow tests of
    Stage 5C and keep every property those tests covered.
  - Behaviour cases run under Git Bash on Windows and bash on CI; the chain command line runs
    against a local fake GitHub API. `tsc --noEmit` is clean.
- `node scripts/ci/assert-private-acceptance.mjs --runner-dir docs/ci/private-acceptance/runner --public-workflow .github/workflows/d3-cross-repo-acceptance.yml`
  passes.
- Mutation check: 34 mutations each switch off one control:
  - 12 in the review;
  - 12 in `chain.mjs`;
  - 7 in the workflows;
  - 3 in the gate.

  Each one fails at least one test. The two the first runs missed (an environment rename in
  Stage 5C, the credentialed-command allowlist here) got dedicated tests.
- Defect fixed from Stage 5C: the review treated `steps.<id>.outputs.token` as a safe expression, so
  copying an App token into another variable was not caught. It is now a credential everywhere,
  with a test and a mutation.
- Not run here: the full DDI suite (no application code changed), and anything on GitHub (nothing is
  pushed or created).
