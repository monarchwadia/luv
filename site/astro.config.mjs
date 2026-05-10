import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  site: "https://luv.dev",
  integrations: [
    starlight({
      title: "luv-js",
      description: "A tiny, zero-dep, isomorphic JS framework for LLM chat + agents.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/monarchwadia/luv" },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What is luv?", slug: "guide/intro" },
            { label: "Quickstart", slug: "guide/quickstart" },
            { label: "Why luv (vs Vercel AI SDK)", slug: "guide/why-luv" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Agents and tools", slug: "guide/agents" },
            { label: "Structured output", slug: "guide/structured-output" },
            { label: "Streaming", slug: "guide/streaming" },
            { label: "Provider middleware", slug: "guide/middleware" },
            { label: "MCP client", slug: "guide/mcp" },
            { label: "Migrating from Vercel AI SDK", slug: "guide/migrate-from-vercel" },
          ],
        },
        {
          label: "API reference",
          items: [
            { label: "send / sendStream / runAgent", slug: "api/core" },
            { label: "createClient", slug: "api/client" },
            { label: "Tool helpers", slug: "api/tools" },
            { label: "Errors", slug: "api/errors" },
            { label: "Middleware", slug: "api/middleware" },
            { label: "MCP", slug: "api/mcp" },
          ],
        },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
