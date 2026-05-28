# Publishing `luv` to npm

Maintainer workflow for publishing the TypeScript reference implementation
to the npm registry. Run from `impl/typescript/`.

## One-time setup

```bash
npm login
```

Browser-based OAuth flow opens. After login, verify:

```bash
npm whoami         # should print your username
```

If 2FA is required (recommended for all npm publishers):

```bash
npm profile enable-2fa auth-and-writes
```

`auth-and-writes` requires OTP for every publish; `auth-only` requires OTP
only on login. Use `auth-and-writes` for any package with a real user base.

## Pre-publish checklist

Run all of these from `impl/typescript/`. Every step must pass.

```bash
# 1. Bench passes locally
bun test
# expect: 27 pass, 0 fail

# 2. Verify request shapes against live API (sanity check spec is current)
bun run verify
# expect: 6 verified, 0 failed
# requires OPENAI_API_KEY in /workspaces/luv/.env

# 3. Live end-to-end smoke test
bun run smoke
# expect: 11 pass, 0 fail
# requires OPENAI_API_KEY

# 4. Clean build
rm -rf dist
bun run build
# expect: no errors; dist/ populated

# 5. Inspect what would be published
bun pm pack
ls -la luv-*.tgz
tar -tzf luv-*.tgz | sort
# Expect 17 files total. Verify NO test/, scripts/, src/, tsconfig*,
# or other dev files appear in the listing. Only dist/, README.md,
# LICENSE, package.json (the last is added by npm automatically).

# 6. Smoke-test the tarball locally before publishing
mkdir -p /tmp/luv-publish-check
cd /tmp/luv-publish-check
rm -rf node_modules package.json bun.lock
echo '{"name":"check","type":"module"}' > package.json
bun add /workspaces/luv/impl/typescript/luv-*.tgz
echo 'import { LUV_SPEC_VERSION } from "luv"; console.log(LUV_SPEC_VERSION);' > t.ts
bun run t.ts
# expect: 1.0
cd -

# 7. Remove the local tarball
rm impl/typescript/luv-*.tgz   # (or just leave; gitignored)
```

If any step fails, fix it before publishing.

## Versioning

luv follows semver:

- **PATCH** (`0.1.0` → `0.1.1`): bug fixes; behavior unchanged for any
  spec-compliant consumer.
- **MINOR** (`0.1.0` → `0.2.0`): additive changes (new arrows, new
  optional fields, new validators). Existing consumers continue working.
- **MAJOR** (`0.x` → `1.0`, or `1.x` → `2.0`): breaking changes to the
  canonical types, arrow signatures, or bench expectations.

For pre-1.0, follow the spirit even though semver technically allows
breaking changes in `0.x`. Bump MINOR for additions; bump PATCH for
fixes. Reserve MAJOR for `0.x → 1.0`.

Bump the version with:

```bash
# Patch: 0.1.0 → 0.1.1
npm version patch -m "release: v%s"

# Minor: 0.1.0 → 0.2.0
npm version minor -m "release: v%s"

# Major: 0.1.0 → 1.0.0
npm version major -m "release: v%s"
```

`npm version` updates `package.json`, creates a git commit, and tags it.
It runs from the package directory (`impl/typescript/`), not the repo
root. The tag is `vX.Y.Z` by default.

If the `spec_version` in `spec/SPEC.md` changes, also bump the package
version (typically MAJOR or MINOR). The two version numbers are not
strictly coupled, but the impl version must indicate the spec version it
targets.

## Publishing

```bash
# Standard publish — releases as the "latest" tag on npm
npm publish --access public

# For a scoped package (if name "luv" is taken, see below)
# --access public is required for scoped packages to be installable
# by non-org members
```

`prepublishOnly` runs `bun run build` automatically; if that fails, the
publish aborts before any network call.

### Pre-release versions

For beta / RC publishes that should NOT be the default `npm install luv`:

```bash
# Bump to a pre-release version
npm version 0.2.0-beta.1 -m "release: v%s"

# Publish under a non-latest dist-tag
npm publish --access public --tag beta
```

Consumers install with `npm install luv@beta`. The `latest` tag is
unaffected.

To promote a beta to latest later:

```bash
npm dist-tag add luv@0.2.0-beta.1 latest
```

## Post-publish verification

```bash
# Confirm the version landed
npm view luv version
# or, for the full record:
npm view luv

# Install from the public registry into a clean directory
mkdir /tmp/luv-postpublish && cd /tmp/luv-postpublish
echo '{"name":"check","type":"module"}' > package.json
bun add luv
bun run -e 'import { LUV_SPEC_VERSION } from "luv"; console.log(LUV_SPEC_VERSION);'
# expect: 1.0
```

If the registry version doesn't appear immediately, wait 30–60 seconds
and retry; CDN propagation is fast but not instant.

## If the name `luv` is taken

Check first:

```bash
npm view luv
# If this returns metadata, the name is taken.
# If it returns "404 Not Found", the name is available.
```

If taken, switch to a scoped name:

```bash
# In package.json, change:
#   "name": "luv"        →  "name": "@monarchwadia/luv"
# (or any scope you own on npm)
#
# Add publishConfig for public access on scoped packages:
#   "publishConfig": { "access": "public" }
```

Consumers then install as `npm install @monarchwadia/luv` and import
exactly the same way (`from "@monarchwadia/luv"`). The `exports` map,
runtime API, and types are unchanged.

## Yanking / deprecating

Never delete a published version (npm permits this only within 24
hours and discourages it strongly). Instead, deprecate:

```bash
# Mark a specific version as deprecated, with a migration note
npm deprecate luv@0.1.0 "Buggy release; upgrade to 0.1.1 or later"

# Deprecate a range
npm deprecate "luv@<0.2.0" "Upgrade to 0.2.0+ for the Anthropic morphism"

# Unpublish (only valid within 72 hours, avoid)
npm unpublish luv@0.1.0
```

## Common publishing errors

| Error | Cause | Fix |
|---|---|---|
| `E401 unauthorized` | Not logged in, or stale token | `npm login` |
| `E403 forbidden` | Trying to publish a name you don't own | Scope it; see above |
| `EOTP` | 2FA required, no OTP provided | Re-run with `--otp=<code>` |
| `EPUBLISHCONFLICT` | Version already published | Bump version |
| `prepublishOnly script failed` | Build failed | `bun run build` locally, fix errors |
| `Cannot publish over previously published version` | Same as above | Bump version |
| `private: true` in package.json | npm refuses to publish | Remove `private: true` (already absent in this repo) |

## Release notes / changelog

There's no `CHANGELOG.md` yet. When the project has a few releases, add
one. For now, the git tag message + the commit history serve as the
record. Standard form for the tag message:

```
release: v0.2.0

Adds:
- Anthropic morphism + transport (Order A item 1)
- ...

Fixes:
- ...

Spec changes:
- ...
```

`npm view luv versions --json` lists all published versions; `git tag`
lists local tags. Push tags with `git push --tags` after publishing.

## Final word

Publishing is irreversible-ish (deprecation, not deletion). Don't
publish a version you wouldn't ship. The pre-publish checklist exists
because every step has caught a real mistake at some point in some
project. Run all of them.
