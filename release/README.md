# Releasing @voxgig/sdkgen-infrapack

**This bootstrap is COMPLETE — kept as the record of how, not as a to-do.**
The workflow is applied, the trusted publisher is registered, and the
registry carries releases. Steps 1 and 2 below are done; step 3 is the one
you want for an ordinary release.

`publish-workflow.patch` is the patch that added
`.github/workflows/publish.yml`, retained so the diff stays reviewable.

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

## Bootstrap: the FIRST release cannot use this workflow

This is why `0.0.1` was published by hand, and the ordering matters more than it looks.

**npm only exposes the trusted-publisher settings once a version already
exists.** There is nothing to register against until the package is there, so
"register the publisher, then run the workflow" is not a sequence anyone can
follow from here — the first step is impossible and the second would fail.

This is not a guess; it is what this toolchain already documents. The
seneca-provider target generates the same workflow for every SDK it builds,
and its header says so directly:

> npm cannot publish a package's FIRST version this way — the settings page
> that configures a trusted publisher only exists once a version is there. So
> release … by hand once, configure the publisher, and every release after
> that is a tag push.

So the order is: **publish once by hand, then register, then automate.**

### 1. Publish the first version by hand, once

From a clean checkout of `main`, with npm authenticated (`npm login`), run the
same gates the workflow would and then publish:

```sh
npm install --no-audit --no-fund
npm run build
npm test
npm run check-package
npm publish --access public          # scoped: restricted by default without this
git tag v1.1.0 && git push origin v1.1.0
```

Tag it too, so the registry and the repository agree from the start — every
later run of the workflow assumes they do.

### 2. Register the trusted publisher

**npm 12 added a CLI for this**, so it is one command rather than a trip
through the website:

```sh
npm install -g npm@latest          # `npm trust` does not exist before 12
npm login

npm trust github @voxgig/sdkgen-infrapack \
  --repo voxgig/sdkgen-infrapack --file publish.yml --allow-publish
```

`--file` is required and is the workflow's filename within
`.github/workflows/`. So is a permission flag — without `--allow-publish`
(or `--allow-stage-publish`) npm refuses with *"At least one permission flag
is required"*. Check it with `npm trust list @voxgig/sdkgen-infrapack`;
`npm trust revoke` undoes it.

The equivalent website route still exists, for npm < 12 or if you prefer it:
npmjs.com → the package → trusted publisher, with these fields.

| field | value |
| --- | --- |
| package | `@voxgig/sdkgen-infrapack` |
| repository | `voxgig/sdkgen-infrapack` |
| workflow | `publish.yml` |

Renaming the workflow file breaks publishing until the npm-side registration
is updated to match.

**A version being on the registry does NOT mean a publisher is registered
against it.** These are two separate steps, and skipping this one fails at
the very end of an otherwise green run:

```
npm error 404 Not Found - PUT https://registry.npmjs.org/@voxgig%2fsdkgen-infrapack
```

That 404 is npm's answer for "no trusted publisher matches this workflow" —
deliberately not a 403, so as not to leak whether the package exists. It cost
this repository a failed dispatch before anyone thought to check.

### 3. Every release after that is the workflow

1. **Bump the version in BOTH `package.json` and `sdkgen-package.json`** on
   `main`. Both files ship, and `package check` does **not** compare them — a
   release bumping only one leaves consumers with conflicting metadata,
   silently. The workflow's first job refuses the release if they disagree,
   so it cannot slip through unnoticed, but it is still yours to keep in step.

   Nothing in the workflow commits: it reads the version already on the
   branch, so the bump stays a reviewable diff.
2. Run the **publish** workflow from `main`, optionally passing `expect_sha`
   to refuse the run if `main` has moved since you decided.
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
