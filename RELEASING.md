# Releasing @glassray/tracing

Releases run through [release-it](https://github.com/release-it/release-it)
(the same engine langfuse-js uses), driven manually by a maintainer — one
command does the whole flow.

## Prerequisites (one-time)

- `npm login` with an account in the `glassray` npm org.
- Push access to this repo.

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
6. **Publishes to npm** via `pnpm publish` (`after:release`). 2FA prompts for
   an OTP if your account requires it.

To publish the current version without bumping (e.g. the very first
`0.1.0`): `pnpm release -- --no-increment`.

<a id="why-pnpm"></a>

> **Why the publish goes through pnpm, not `npm publish`:** the development
> `exports` map points at TypeScript source so the monorepo can consume the
> package unbuilt; pnpm rewrites it from `publishConfig` to `dist/` at pack
> time. A raw `npm publish` would ship the src-pointing manifest. This is
> encoded in `.release-it.json` (`npm.publish: false` + the `after:release`
> hook) — don't bypass it.

## After publishing

- Verify: `npm view @glassray/tracing` and a scratch `npm i @glassray/tracing`
  smoke test.
- If this checkout is the Glassray monorepo submodule: bump the gitlink in
  the parent repo (`git add packages/sdk` + commit) so the platform pins the
  released commit.

## Later (when the repo is public and final)

Move the same flow into GitHub Actions the way langfuse-js does: a
`workflow_dispatch` release workflow wrapping `release-it --ci` with a
CI-specific config, npm Trusted Publishing (OIDC) + `--provenance`, a
dry-run input, and a main-branch guard. Until then, releases stay
maintainer-run by design.
