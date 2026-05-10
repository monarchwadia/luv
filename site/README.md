# luv-js documentation site

Astro Starlight site for luv-js. Built from `src/content/docs/`.

## Setup

```bash
cd site
bun install
bun run dev      # local dev server at http://localhost:4321
bun run build    # static build → ./dist
bun run preview  # preview the built site
```

## Deploy to Cloudflare Pages

1. Push to GitHub.
2. In Cloudflare dashboard → Pages → Create project → Connect to GitHub.
3. Build command: `bun install && bun run build`
4. Build output directory: `dist`
5. Root directory: `site`

(For other targets — Vercel, Netlify, Fly — the static `dist/` directory
works as-is.)

## Structure

```
site/
├── astro.config.mjs        # Starlight config + sidebar
├── src/
│   ├── content/docs/
│   │   ├── index.mdx       # landing page (splash hero + cards)
│   │   ├── guide/
│   │   │   ├── intro.md
│   │   │   ├── quickstart.md
│   │   │   ├── why-luv.md
│   │   │   ├── agents.md
│   │   │   ├── structured-output.md
│   │   │   ├── streaming.md
│   │   │   ├── middleware.md
│   │   │   ├── mcp.md
│   │   │   └── migrate-from-vercel.md
│   │   └── api/
│   │       ├── core.md     # send / sendStream / runAgent / agentStep
│   │       ├── client.md
│   │       ├── tools.md
│   │       ├── errors.md
│   │       ├── middleware.md
│   │       └── mcp.md
│   └── styles/custom.css
└── package.json
```

## Notes

- Source of truth for all content is the markdown in `src/content/docs/`.
- The package's `lib/js/README.md` is a quick-reference; this site is
  the canonical narrative.
- Once a real domain is decided (luv.dev or otherwise), update `site` in
  `astro.config.mjs`.
