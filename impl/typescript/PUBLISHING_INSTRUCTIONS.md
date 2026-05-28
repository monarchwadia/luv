# Publishing `luv` to npm

Run from `impl/typescript/`.

```bash
# 1. Log in (one-time)
npm login

# 2. Bump the version (patch | minor | major)
npm version patch

# 3. Publish
npm publish --access public
```

`prepublishOnly` runs `bun run build` automatically before publishing.
If the build or tests fail, the publish aborts.

If the name `luv` is taken on npm, rename to `@<your-scope>/luv` in
`package.json` before step 3.
