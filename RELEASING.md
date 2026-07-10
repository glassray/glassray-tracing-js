# Releasing @glassray/tracing

Releases run through [release-it](https://github.com/release-it/release-it)
(the same engine langfuse-js uses), driven manually by a maintainer — one
command does the whole flow **except the npm publish**, which happens in
GitHub Actions via [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC): pushing the release tag triggers `.github/workflows/release.yml`,
which re-runs the gates, builds, and publishes. No npm token exists anywhere
— not on laptops, not in repo secrets — and npm attaches a provenance
attestation linking the tarball to the exact commit and workflow run.

## Prerequisites (one-time)

- Push access to this repo.
- The npm package must have a **trusted publisher** configured
  (npmjs.com → `@glassray/tracing` → Settings → Trusted Publisher):
  GitHub Actions, owner `glassray`, repo `glassray-tracing-js`, workflow
  `release.yml`, no environment. While there, set publishing access to
  **trusted publisher only** so tokens can't publish at all.

## Cut a release

From this directory, on `main`, with a clean tree:

```sh
pnpm release:dry   # full rehearsal — prints every step, changes nothing
pnpm release       # prompts for the version bump, then does everything
```

What it does, in order (see `.release-it.json`):

1. **Gates** — typecheck, lint, tests must pass (`before:init`).
2. **Bumps** `package.json` (you pick patch/minor/major at the prompt;
   strict semver, `0.x` during the pilot).
3. **Builds** `dist/` with tsup (`after:bump`).
4. **Commits** `chore: release v<version>`, **tags** `v<version>`, and
   **pushes** with tags.
5. **Opens a GitHub release** in your browser, pre-filled with
   auto-generated notes — review and publish it.
6. The pushed `v<version>` tag **triggers the Release workflow**
   (`.github/workflows/release.yml`), which re-runs the gates and
   **publishes to npm** via trusted publishing. Watch it in the repo's
   Actions tab; the npm page shows the provenance badge when it's done.

To publish the current version without bumping (e.g. the very first
`0.1.0`): `pnpm release -- --no-increment`.

<a id="why-pnpm"></a>

> **Why the workflow packs with pnpm, not `npm pack`:** the development
> `exports` map points at TypeScript source so the monorepo can consume the
> package unbuilt; pnpm rewrites it from `publishConfig` to `dist/` at pack
> time. A raw `npm publish` from the repo would ship the src-pointing
> manifest. The workflow therefore runs `pnpm pack` and then publishes the
> resulting tarball with npm (which does the OIDC exchange) — don't bypass
> it with a manual `npm publish`.

## After publishing

- Verify: `npm view @glassray/tracing` and a scratch `npm i @glassray/tracing`
  smoke test.
- If this checkout is the Glassray monorepo submodule: bump the gitlink in
  the parent repo (`git add packages/sdk` + commit) so the platform pins the
  released commit.

## Later

If maintainer-driven releases become a bottleneck, the version/tag half can
also move into Actions (a `workflow_dispatch` wrapping `release-it --ci`,
the way langfuse-js does it). The publish half is already there.
