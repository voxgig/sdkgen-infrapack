# Releasing @voxgig/sdkgen-infrapack

This repository has no release workflow. That is the gap this directory
closes.

`publish-workflow.patch` adds `.github/workflows/publish.yml`.

## Why a patch and not the file

Automation that writes to `.github/workflows/` needs the GitHub App
`workflows` permission, which the agent that prepared this branch does not
hold — the push is refused outright:

```
! [remote rejected] refusing to allow an OAuth App to create or update
  workflow `.github/workflows/publish.yml` without `workflow` scope
```

Shipping the workflow as a patch keeps it reviewable in the diff and lets a
maintainer apply it with their own credentials.

## Apply it

```sh
git apply release/publish-workflow.patch
git add .github/workflows/publish.yml
git commit -m "ci: publish workflow"
```

The patch is checked to apply cleanly against the commit that introduced it,
and the resulting YAML parses.

## Where this workflow came from

It is `voxgig/sdkgen-langpack`'s `publish.yml`, adapted. That file is the
reviewed one — three jobs at least privilege, publish-before-tag, and the
containment guard that refuses to release a commit not on `main`. Two things
differ, and only two:

| | langpack | here |
| --- | --- | --- |
| package name | `@voxgig/sdkgen-langpack` | `@voxgig/sdkgen-infrapack` |
| install | `npm install` (no lockfile) | **`npm ci`** (this repo commits one) |

`npm ci` is the point of the second row: a release must build the dependency
tree the repository pins, not whatever resolves on the day.

## Before the first dispatch: the registry and this repo disagree

`@voxgig/sdkgen-infrapack@0.0.1` is on npm, and npm records its `gitHead` as
`2953fef7824fa0ba6ec21816b75ffebafcfa5969` — **a commit that is not in this
repository's history**. Whatever produced that release, it was not this tree.

That matters for one gate. `A published version must come from this commit`
compares npm's `gitHead` against the release commit, and it only runs for a
version already on the registry. So:

- releasing **1.0.0** (what both manifests say today) never consults that
  0.0.1 record and is unaffected;
- re-releasing **0.0.1** would trip it, correctly.

Worth resolving the provenance question on its own terms rather than through
a release.

## Bootstrap: is the trusted publisher registered?

**npm only exposes the trusted-publisher settings once a version already
exists.** `0.0.1` exists, so the settings page is available — but a version
being on the registry does NOT mean a publisher is registered against it.
Confirm the registration before dispatching, or the run fails at the publish
step with a 404 that names nothing:

```
npm error 404 Not Found - PUT https://registry.npmjs.org/@voxgig%2fsdkgen-infrapack
```

That 404 is npm's answer for "no trusted publisher matches this workflow" —
it is deliberately not a 403, so as not to leak whether the package exists.
It is the same failure `@voxgig/sdkgen-langpack` hit on its first dispatch.

Register on npmjs.com, for this package, against this repository and this
exact workflow filename:

| field | value |
| --- | --- |
| package | `@voxgig/sdkgen-infrapack` |
| repository | `voxgig/sdkgen-infrapack` |
| workflow | `publish.yml` |

Renaming the workflow file breaks publishing until the npm-side registration
is updated to match.

## Every release after that

1. **Bump the version in BOTH `package.json` and `sdkgen-package.json`.**
   Both files ship, and `package check` does not compare them — a release
   bumping only one leaves consumers with conflicting metadata, silently.
   The workflow's first job refuses a release where they disagree, so it
   cannot slip through unnoticed, but keeping them in step is yours.

   Nothing in the workflow commits: it reads the version already on the
   branch, so the bump stays a reviewable diff.
2. Run the **publish** workflow from `main`, optionally passing `expect_sha`
   to refuse the run if `main` has moved since you decided.
3. It publishes to npm, then tags `v<version>`.

Publishing happens before tagging, so a tag only ever exists for a release
that reached the registry — a failed publish leaves no tag behind, which is
what makes a re-dispatch safe. A version already on npm is skipped, and a tag
already on the same commit is a no-op.

## What it refuses

- a release whose two manifest versions disagree;
- a dispatch from any branch but `main`;
- a commit not contained in `main`, on either entry point — a `v*` tag can be
  pushed from any commit, so matching `package.json` is not enough by itself;
- a pushed tag whose name disagrees with `package.json`;
- a tag that already exists on a *different* commit;
- a version already on npm built from a *different* commit (`gitHead`).

## Gates

`npm ci`, then `npm run build`, `npm test`, and `npm run check-package` —
this repository is itself an sdkgen package, so its own authoring gate is a
release gate.
