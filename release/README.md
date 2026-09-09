# Releasing @voxgig/sdkgen-infrapack

This package has never been published, and this repository has no release
workflow. That is the gap this directory closes.

`publish-workflow.patch` adds `.github/workflows/publish.yml`, modelled on
the one `voxgig/sdkgen` already uses.

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
introduced it (`git apply --check`).

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
console — I could not verify it from here.

## Release

Once the publisher is registered, releasing is a button:

1. Bump `version` in `package.json` on `main` (currently `1.1.0`). Nothing in
   the workflow commits — it reads the version already on the branch, so the
   bump stays a reviewable diff.
2. Run the **publish** workflow from `main`, optionally passing
   `expect_sha` to refuse the run if `main` has moved since you decided.
3. The workflow publishes to npm, then tags `v<version>`.

Publishing happens before tagging, so a tag only ever exists for a release
that reached the registry. Re-dispatching after a partial failure is safe: a
version already on npm is skipped, and a tag already on the same commit is a
no-op.

## What the workflow runs as its gates

`npm install` (this repo commits no lockfile, so not `npm ci`), then
`npm run build`, `npm test`, and `npm run check-package` — the package's own
authoring gate. All four were verified to pass on this branch before the
patch was written.
