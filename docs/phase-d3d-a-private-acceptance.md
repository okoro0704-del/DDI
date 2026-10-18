# Stage 5C — private-repository acceptance

Local preparation only. Nothing in this stage created a credential, a GitHub App, a repository, an
environment or a secret; changed visibility, a ruleset or an Actions setting on any repository; or
merged anything. Every setting in §6 needs separate approval. PR #11 (`pdi` → `master`) stays NO-GO
until §7 has run on its exact merge tree.

## 1. Why acceptance stopped

LifeOS Portal (`okoro0704-del/LifeOS-Portal`) became private on 2026-10-18 (08:18:54Z); anonymous
reads now return 404. The D3 cross-repository acceptance checked it out with no credential (DDI's
pull-request jobs hold none), so its run on PR #11 head `5fd550d` failed at the Portal checkout,
before any suite ran. Master Distributor, TrustID and ElfCom are still public.

### 1.1 Verified GitHub behaviour

| Fact | Source |
| --- | --- |
| GitHub scrubs from runner memory only secrets "not referenced in the workflow"; `GITHUB_TOKEN` and referenced secrets "can be harvested by a determined attacker" running in the job. The documented boundary is the workflow, not the job. | [Compromised runners](https://docs.github.com/en/actions/concepts/security/compromised-runners) |
| Environment secrets are "only available to workflow jobs that reference the environment". In private repositories they need GitHub Pro, Team or Enterprise; on Free, after a repository goes private, "environment secrets will be ignored". | [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) |
| With Pro or Team, deployment branch policies work in private repositories; required reviewers and wait timers do not (public repositories only below Enterprise). | [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) |
| A ruleset's required check can name the app that must report it (`integration_id`); GitHub Actions is app 15368. Only GitHub Apps can create check runs. | [Available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [Checks API](https://docs.github.com/en/rest/checks/runs) |

Observed (read-only API, 2026-10-18): the owner account is on GitHub **Free**. LifeOS-Portal returns
"Upgrade to GitHub Pro or make this repository public" for rulesets and branch protection, so the
private Portal `main` currently has no branch protection. Portal's only collaborator is
`okoro0704-del`. DDI has no Actions secrets and no environments. Portal commit `316a07b` (tree
`e354ae4`) has no `.gitattributes`, submodules or symlinks. A `git archive` of it, re-added with
`core.autocrlf=false`, reproduces that tree exactly (checked locally).

## 2. Options considered

| Option | Verdict |
| --- | --- |
| Personal access token or App key as a DDI secret, used by the `pull_request` job | Rejected. The credential sits in the same job as untrusted pull-request code. |
| `pull_request_target` with a secret | Rejected. The workflow file is trusted, but the candidate's tests must still run, and they would run beside the secret. DDI is public, so Portal source and test output would land in public logs and artifacts. |
| Any credentialed job inside DDI | Rejected. DDI's logs and artifacts are public. |
| Run in LifeOS-Portal with its own `GITHUB_TOKEN` | Rejected. Candidate code in a `main` run there gets the Actions cache write scope of Portal's default branch, which lets it poison Portal's own CI and release builds. It also changes the Portal repository. |
| Single workflow in a dedicated private repository, repository-level secrets (Free plan) | Rejected. GitHub's documented scrubbing is per workflow, so the App keys could be in the untrusted job's runner memory. |
| **Single workflow in a dedicated private repository, two GitHub Apps, environment-scoped secrets (GitHub Pro)** | **Selected.** See §3 and §4. |
| Dedicated private repository on Free: three workflows (credentialed Portal snapshot, credential-free acceptance, credentialed reporter on `workflow_run`) | Fallback if Pro is declined. It needs no plan change but has more moving parts: cross-run artifact transfer and parsing the dispatch inputs from `run-name`. It is not implemented. |

## 3. Selected architecture

Runner repository `okoro0704-del/ddi-private-acceptance` (private, sole maintainer
`okoro0704-del`). Its only workflow is `.github/workflows/ddi-private-acceptance.yml`, byte-identical
to `docs/ci/private-acceptance/ddi-private-acceptance.yml` here. It is started by hand with
`pr`, `head_sha` (the reviewed head) and `base` (`master` or `pdi`), from `main` only.

| Job | Credentials | Runs | Produces |
| --- | --- | --- | --- |
| `resolve` | Its own repository's `contents: read` token; reads public DDI data | No candidate code: git and `gh` on data only | Head, base, merge tree, workflow blob |
| `fetch-portal` | Environment `ddi-acceptance-portal-read`: App "Portal reader" key mints a token with Contents read, on LifeOS-Portal only, revoked at job end | Checkout of the pinned Portal commit, `git archive`; no Portal code | One private artifact (`portal.tar.gz`, one day) and its SHA-256 |
| `acceptance` | None: no environment, `permissions: {}`, no secret | The candidate and every suite (DDI, Portal, Master Distributor, three D3 end-to-end suites) on loopback PostgreSQL | A job result only; nothing reads its outputs |
| `report` | Environment `ddi-acceptance-report`: App "DDI reporter" key mints a token with Checks write, on DDI only, revoked at job end | One `gh api` POST | The check run `ddi-private-acceptance` on the DDI head commit |

Checks performed before anything runs:

1. `resolve` refuses a run unless it is dispatched from `main`, the inputs are well formed and the
   pull request is open. It also refuses unless the head comes from `okoro0704-del/DDI`, the PR still
   targets `base`, the PR head is exactly the reviewed `head_sha`, the base tip is an ancestor of the
   head and the merge tree equals the head tree. Under the ruleset's strict mode, the tree tested is
   then the tree that merges.
2. Pin binding. If the candidate carries the template, it must be byte-identical to the running
   workflow. Every pin the candidate's `d3-cross-repo-acceptance.yml` declares must equal the
   runner's. Master Distributor, TrustID and ElfCom are always declared; Portal is declared by the
   template, or for a candidate from before the template, such as PR #11, by the public workflow.
3. `acceptance` first refuses any credential-shaped variable, printing names only. It re-derives the
   merge tree, then checks the Portal archive's SHA-256 against `fetch-portal`'s output. Finally it
   re-adds the extracted files and requires git tree `PORTAL_TREE`. An archive that was substituted,
   edited or carries `.git` is refused.
4. `report` posts `success` only when `fetch-portal` and `acceptance` both succeeded. It posts
   `failure` for any other outcome, including a missing or rejected Portal credential. If `resolve`
   fails, or the reporter credential is missing, nothing is posted, and the required check stays
   absent, which blocks the merge.

## 4. Trust boundary

| Asset | Reachable by | Controls |
| --- | --- | --- |
| Portal reader App key | `fetch-portal` only | Environment secret, deployment branch `main` only. That job runs only allowlisted commands. The App is installed on LifeOS-Portal alone, with Contents read alone. |
| DDI reporter App key | `report` only | Environment secret, `main` only, one allowlisted `gh` call. The App is installed on DDI alone, with Checks write alone. |
| App installation tokens | The job that minted them | Scoped to one repository and one permission; revoked when the job ends (`skip-token-revoke` is never set). Never written to outputs, env files or logs. |
| `GITHUB_TOKEN` | Every job, per job | `permissions: {}` everywhere except `resolve` (`contents: read` on the runner repository). |
| Portal source | `fetch-portal`, `acceptance`, the one-day artifact, private logs | The private runner repository only. Nothing is posted to DDI except SHAs and results. |
| The `ddi-private-acceptance` result | DDI ruleset | Required with the reporter App's `integration_id`. DDI's gate refuses any DDI job using that name, and any DDI workflow granting checks or statuses write. |
| Actions cache | `acceptance` (runtime token) | The runner repository uses no cache anywhere, so a poisoned entry has no reader. It is a separate repository from Portal. |

Threats and their answers:

- **Credential theft by candidate code.** Credentials never share a job or a runner with candidate
  code. That rests on GitHub's environment-secret scoping (Pro), not on log masking.
- **Forged success.** Only the reporter App can create a check that satisfies the ruleset. DDI
  workflows run as app 15368 and cannot satisfy it. The candidate cannot influence `report`, which
  reads job results and `resolve`'s values only.
- **Stale or swapped code.** `resolve` binds the run to the reviewed `head_sha`, and the result is
  attached to that commit. A newer head, or a moved base under strict mode, needs a new run.
- **Silent drift.** Pins are full SHAs bound to the candidate's declarations, and Portal also to a
  tree hash. Actions are pinned to allowlisted commits. The runner workflow must match the template
  reviewed in public DDI, and `scripts/ci/assert-private-acceptance.mjs` reviews that template in
  every DDI test run.
- **Unapproved runs.** Only a maintainer of the private repository can dispatch. Environment
  secrets only reach `main`, and `resolve` re-checks the ref.

Residual risks, accepted or owned:

- Candidate code sees the Portal source. That is the purpose of the run. The maintainer reviews the
  exact `head_sha` before dispatching. Third-party npm lifecycle scripts run beside it as well, the
  same exposure as Portal's own CI.
- A compromised reporter key could post a false `success` until it is rotated. The key is held only
  as an environment secret. Rotation is to generate a new key, replace the secret and delete the old
  key.
- Candidate code controls its own tests. Acceptance proves the reviewed candidate against pinned
  dependencies; it does not replace review.
- GitHub-hosted runners and GitHub-owned actions are trusted at their pinned commits.
- On a single-maintainer account, the dispatch is the approval: required reviewers are unavailable
  for private repositories below Enterprise.

## 5. Implemented in DDI (this branch, `ci/d3d-a-private-acceptance`)

- `scripts/ci/assert-ci-safety.mjs`:
  - the check name `ddi-private-acceptance` is reserved, so no DDI job may publish it;
  - LifeOS-Portal is removed from the public dependency allowlist;
  - the strict parser accepts the empty mapping `{}` and nothing else new.
- `.github/workflows/d3-cross-repo-acceptance.yml`: now covers public dependencies only (DDI, Master
  Distributor, TrustID, ElfCom). It gives pull requests a meaningful signal again, where every run
  previously failed at the Portal checkout before any suite. The Portal and end-to-end suites moved
  to the private run.
- `docs/ci/private-acceptance/ddi-private-acceptance.yml`: the runner template.
- `scripts/ci/assert-private-acceptance.mjs`: the review of that template, run by `tests/private-acceptance.test.ts`.
- Tests:
  - `tests/private-acceptance.test.ts`: adversarial static cases for every property in Stage 5C
    Phase D, plus behaviour cases that run the template's own scripts against local fixtures (fake
    `gh`, git confined to `file://`);
  - `tests/ci-safety-gate.test.ts`: reserved name, Portal refused, `{}` parsing.

PR #11's frozen candidate does not need this branch: its public workflow declares all four pins,
which `resolve` accepts. Landing this branch in `pdi` first, then refreshing PR #11, makes the
accepted `master` tree carry the gate hardening and the template, at the cost of re-freezing PR #11.
That ordering is a founder decision.

## 6. Settings to apply after approval (prepared, not applied)

Founder:

1. **Plan.** Upgrade `okoro0704-del` to GitHub Pro. Without it, use the Free fallback in §2 instead;
   do not put these keys in repository-level secrets.
2. **Runner repository.** Create `okoro0704-del/ddi-private-acceptance`: private, no other
   collaborators, default branch `main`.
   - Commit the template byte-for-byte as `.github/workflows/ddi-private-acceptance.yml`.
   - Ruleset on `main`: block deletion and non-fast-forward.
   - Actions: allow GitHub-owned actions only, require SHA pinning, default workflow permissions
     read.
   - No repository or account secrets.
3. **App "DDI acceptance reporter".**
   - Owner `okoro0704-del`, installable only on this account, webhook inactive.
   - Repository permissions: Checks read and write (Metadata read is implicit). No events.
   - Install on `okoro0704-del/DDI` only.
   - Environment `ddi-acceptance-report` in the runner repository:
     - deployment branches: `main` only;
     - variable `DDI_REPORTER_APP_ID`;
     - secret `DDI_REPORTER_PRIVATE_KEY` (one generated key; delete the downloaded file).
4. **DDI ruleset 25324301 (`master`).** Add the required check
   `{"context": "ddi-private-acceptance", "integration_id": <reporter App ID>}` beside
   `ddi-trusted-ci-review` and keep the other rules unchanged. Do the same for `pdi` (25336320) only
   if every `pdi` pull request should need a private run.

Portal release owner (Phase C request; nothing changes in the Portal repository):

5. **App "DDI acceptance Portal reader".**
   - Owner `okoro0704-del`, installable only on this account, webhook inactive.
   - Repository permissions: Contents read-only (Metadata read is implicit). No events.
   - Install on `okoro0704-del/LifeOS-Portal` only.
   - Environment `ddi-acceptance-portal-read` in the runner repository:
     - deployment branches: `main` only;
     - variable `PORTAL_READER_APP_ID`;
     - secret `PORTAL_READER_PRIVATE_KEY`.
6. **Keep the pin reachable.** `316a07b7ad94f5a5eacff790906aa879537439ef` is reachable only from
   `feature/portal-d3d-b1-install-recovery`. Keep that branch, or tag the commit (for example
   `ddi-acceptance/316a07b`), and never rewrite it. A new pin goes through a DDI pull request that
   changes `PORTAL_SHA` and `PORTAL_TREE` in the template, after Portal review.

Visibility, branch protection, credentials and deployment settings of LifeOS-Portal are not changed
by this plan.

## 7. Acceptance run for PR #11 (after §6)

1. Confirm PR #11 is still at head `5fd550daafcafea92888b8d9ea5668fad0580c44` and `master` at
   `0ed6dd70e40c4bb5f45699cff6a9874d3b6b3ba6`. The merge tree, which equals the head tree, is
   `56a737e42c224e380073ade6726a0a68cc7aa5ce`.
2. Dispatch `ddi-private-acceptance` with `pr=11`, `head_sha=5fd550d…`, `base=master`.
3. Verify the run:
   - every job and suite executed: the step logs show test counts, and none is skipped;
   - the check run on `5fd550d` is from the reporter App, with the expected SHAs, tree and pins;
   - no secret appears in the private logs, and the only artifact is `portal-source`, expiring in
     one day;
   - no deployment step exists. The environment records in the runner repository are GitHub
     bookkeeping, not a service deployment.
4. Spoof checks:
   - a commit status and a GitHub Actions check named `ddi-private-acceptance` on a test pull
     request must leave it blocked;
   - the genuine `ddi-trusted-ci-review` must still be required.

## 8. Verification (local)

- `node --test tests/private-acceptance.test.ts tests/ci-safety-gate.test.ts`: 65 tests, 65 passing
  (the behaviour cases run under Git Bash on Windows and bash on CI). `tsc --noEmit` is clean.
- `node scripts/ci/assert-private-acceptance.mjs --workflow docs/ci/private-acceptance/ddi-private-acceptance.yml --public-workflow .github/workflows/d3-cross-repo-acceptance.yml`
  passes.
- Mutation check: 15 mutations each switch off one control:
  - 7 in the review: credential slots, the credentialed-command allowlist, URLs and the Portal name,
    the single `gh` call, executors beside credentials, trusting the acceptance outputs, and the
    environments;
  - 4 in the template: the `.git` refusal, the Portal tree check, success on either result, and the
    behind-base check;
  - 3 in the gate: the reserved name, Portal back in the allowlist, and `{}` refused.

  Each one fails at least one test.
- Portal archive round trip at `316a07b`: `git archive`, then extract, then re-add, gives tree
  `e354ae4f3cdf2308a373805f7d1f403685f4253f`.
- Not run here: the full DDI suite (it needs PostgreSQL and the pinned TrustID and ElfCom builds; no
  application code changed), and any GitHub run of these files (nothing is pushed).
