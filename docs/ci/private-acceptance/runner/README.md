# ddi-private-acceptance

Private runner for DDI's cross-repository acceptance against the private LifeOS Portal. This
repository must contain exactly the files of `docs/ci/private-acceptance/runner/` in
`okoro0704-del/DDI`, byte for byte. A DDI candidate that carries that directory is accepted only by a
runner whose tree equals it.

| Workflow | Started by | Credentials | Runs |
| --- | --- | --- | --- |
| `portal-snapshot.yml` | Maintainer, by hand, on `main` | Portal reader App key (Contents read, LifeOS-Portal only) | Archives the pinned Portal commit; no code |
| `ddi-acceptance.yml` | Maintainer, by hand, on `main` | None: references no secret or variable | The DDI candidate and every suite |
| `ddi-report.yml` | GitHub, when an acceptance run completes | DDI reporter App key (Checks write, DDI only) | `scripts/chain.mjs` on GitHub's records; posts `ddi-private-acceptance` |

To accept a DDI pull request:

1. Review the head commit.
2. If no successful snapshot run exists at the current `main` from the last 7 days, run *DDI acceptance
   Portal snapshot*.
3. Run *DDI private acceptance* with the pull request number, the reviewed head SHA, the base branch,
   the base tip SHA and the snapshot run id.

The report follows by itself. Design and threat model: `docs/phase-d3d-a-private-acceptance.md` in DDI.
