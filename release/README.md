# Releasing @voxgig/sdkgen-infrapack

This package has never been published, and this repository has no release
workflow. That is the gap this directory closes.

`publish-workflow.patch` adds `.github/workflows/publish.yml`.

## Why a patch and not the file

Automation that writes to `.github/workflows/` needs the GitHub App
`workflows` permission, which the agent that prepared this branch does not
hold. Shipping the workflow as a patch keeps it reviewable in the diff and
lets a maintainer apply it with their own credentials.

## Apply it

```sh
git apply release/publish-workflow.patch
git add .github/workflows/publish.yml
git commit -m "ci: publish workflow"
```

The patch is checked to apply and reverse cleanly against the commit that
introduced it.

## Then register the trusted publisher — this cannot be scripted

The workflow publishes over OIDC, with **no npm token anywhere**. npm will
refuse the exchange until a trusted publisher is registered for this package
on npmjs.com, against this repository and this exact workflow filename:

| field | value |
| --- | --- |
| package | `@voxgig/sdkgen-infrapack` |
| repository | `voxgig/sdkgen-infrapack` |
| workflow | `publish.yml` |

Renaming the workflow file breaks publishing until the npm-side registration
is updated to match.

Note that `@voxgig/sdkgen-infrapack` does not yet exist on the registry, so this is a **first**
publish. The workflow passes `--access public` for that reason: npm defaults
a scoped package to restricted on its first publish. Whether npm lets you
register a trusted publisher for a name that has never been published, or
wants a first publish by another route, is the one step to confirm at the
console — it could not be verified from here.

## Release

Once the publisher is registered, releasing is a button:

1. **Bump the version in BOTH `package.json` and `sdkgen-package.json`** on
   `main` (both currently `1.1.0`). Both files ship, and `package check` does
   **not** compare them — a release bumping only one leaves consumers with
   conflicting metadata, silently. The workflow's first job refuses the
   release if they disagree, so this cannot slip through unnoticed, but it is
   still yours to keep in step.

   Nothing in the workflow commits: it reads the version already on the
   branch, so the bump stays a reviewable diff.
2. Run the **publish** workflow from `main`, optionally passing
   `expect_sha` to refuse the run if `main` has moved since you decided.
3. It publishes to npm, then tags `v<version>`.

Publishing happens before tagging, so a tag only ever exists for a release
that reached the registry. Re-dispatching after a partial failure is safe: a
version already on npm is skipped, and a tag already on the same commit is a
no-op.

## The shape of the workflow, and why

Three jobs, each holding the least privilege it can. No job holds a
credential while running code it did not write.

| job | permissions | runs |
| --- | --- | --- |
| `verify` | `contents: read` | `npm install`, build, tests, `check-package` |
| `publish` | `id-token: write`, `contents: read` | `npm publish` — **no project dependencies, no project code** |
| `tag` | `contents: write` | git, and nothing else |

The split is the point. A compromised dependency lifecycle script can ask the
runner for any OIDC token the **job** is permitted to mint, so a job that both
installs dependencies and holds `id-token: write` can be made to publish as
this package before its own gates finish. The publish job installs nothing:
this package ships pure source (`files` is `.sdk` plus the manifest, and the
build is `noEmit`), so there is nothing to build in order to pack it.

### What it refuses

- a release whose two manifest versions disagree;
- a dispatch from any branch but `main`;
- **a commit not contained in `main`, on either entry point** — a `v*` tag can
  be pushed from any commit, so matching `package.json` is not enough by
  itself;
- a pushed tag whose name disagrees with `package.json`;
- a tag that already exists on a *different* commit;
- a version already on npm built from a *different* commit (`gitHead`).

### Dist-tags

A prerelease publishes under `next`, never `latest`. A stable version claims
`latest` only if it is the newest stable on the registry — publishing a
historical tag, or two dispatches finishing out of order, would otherwise move
`latest` backward and hand unpinned installs an older release. An older stable
publishes under `previous` and leaves `latest` alone.

## What the workflow runs as its gates

`npm install` (this repo commits no lockfile, so not `npm ci`), then
`npm run build`, `npm test`, and `npm run check-package` — the package's own
authoring gate. All four were verified to pass on this branch before the
patch was written.
