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
pre-push hook probes for `node` because the comment gate is a Node script; it
does not check the major, and it does not need `make`, which the prescribed
gate command below does.

```bash
npm install          # writes an ignored lockfile; see below
npm run build        # type-checks the target's components
npm test             # the comment gate, then the suite
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

## Source code comments

Follow [COMMENT-POLICY.md](COMMENT-POLICY.md): comments are sparse and terse,
only for intricate or surprising code. Names carry intent; documents carry
requirements. Run `make comments comments-test` after editing source.

Durable implementation rationale is in [COMMENT-NOTES.md](COMMENT-NOTES.md).
