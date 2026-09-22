# Agent guide

`CLAUDE.md` is a symlink to this file. One guide, so there is nothing to keep
in step — edit this one.

## The environment is not a property of this repository

This repository is worked on from MORE THAN ONE MACHINE, and from ephemeral
containers whose installed software differs from each other and from any
developer's workstation. A toolchain, path or version present in one is
routinely absent in the next.

So never record an inventory of what is installed as though the repository
owned it, and never conclude that something cannot be built, run or verified
without checking the CURRENT environment first — `command -v <tool>` settles it
in a second. Equally, a note anywhere saying a tool "was not available" is a
fact about the environment that note was written in, and never about yours.

The same rule reads the other way: a sibling repository's guide asserting which
compilers a machine has is that machine's inventory, not a description of
anything you are running in. Probe rather than believe it.

An absolute path in a note, a log or a comment is that run's path. Write one
that is an example so it reads as an example — this suite stages consumer
projects in a temporary directory, so even its own paths differ per run.

## What this repository needs, as distinct from what a machine has

Node 24, npm, and `make`. Those are REQUIREMENTS, not a claim that they are
present: probe first. `command -v` answers only whether a binary exists, and
Node's major is part of the requirement, so read `node --version` — nothing
here enforces it, since `package.json` declares no `engines.node`. The
pre-push hook probes for `node` because the gates it runs are Node scripts; it
does not check the major, and it does not need `make`, which the prescribed
gate commands below do.

```bash
npm install          # writes an ignored lockfile; see below
npm run build        # type-checks the target's components
npm test             # the comment gate, the dependency gate, then the suite
npm run check-package # this repo is itself an sdkgen package
```

`package-lock.json` is gitignored rather than absent, so a fresh checkout and
CI resolve dependencies anew, and a persistent checkout does not: npm writes
the lock on the first install and reuses it while its versions still satisfy
`package.json`. To see what a consumer would get today, remove the lock or
install into a clean clone.

No other LANGUAGE toolchain is in play — the target emits a TypeScript
package. CI runs on ubuntu only; whether any of this works on Windows or macOS
is untested rather than known.

## Committed dependencies name published packages

A committed dependency must name a published npm package or a GitHub
reference. `file:`, `link:`, `portal:`, `workspace:`, `catalog:`, a bare
filesystem path, a packed archive, a git reference to a host other than
github.com, an off-registry `overrides` or `resolutions`, a lockfile entry
resolving from a path or a foreign registry, a committed archive, a symlink
escaping the repository or pointing into `node_modules`, and an `.npmrc` naming
another registry are all findings. Symlinking a sibling checkout to test an
unreleased tool is the right way to work; it is wrong in a commit, and undoing
it is part of finishing.

`tools/dep-gate.cjs` enforces that. It reads every tracked `package.json`,
lockfile, `go.mod`, `Cargo.toml` and `.npmrc`, plus tracked symlinks and
archives. `make deps` runs it, `make deps-test` runs its own suite, `npm test`
runs it before the suite, `.githooks/pre-push` runs it before anything leaves
the machine, and `.github/workflows/deps.yml` runs both on every push and pull
request.

It judges the tracked file SET, so wiring that git does not track — this
repository's ignored `package-lock.json`, an untracked `go.work` — is invisible
and stays legal. Content comes from the working tree, so editing a tracked
manifest goes red at once rather than at `git add`.

An exception goes in `tools/dep-gate.json` with a reason. The gate reports an
entry carrying no reason, and an entry that has stopped matching anything, so
the list cannot outlive what it excused.

## Source code comments

Follow [COMMENT-POLICY.md](COMMENT-POLICY.md): comments are sparse and terse,
only for intricate or surprising code. Names carry intent; documents carry
requirements. Run `make comments comments-test` after editing source.

Durable implementation rationale is in [COMMENT-NOTES.md](COMMENT-NOTES.md).
