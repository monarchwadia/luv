import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  consume_luv_stream_reply,
  produce_luv_stream_reply,
  validate_luv_conversation,
  encodeReply,
  encodeStreamReply,
  encodeValidationResult,
  stringify,
} from "../src/index.js";
import {
  luv_conversation_to_openai_request,
  openai_response_to_luv_reply,
  openai_stream_to_luv_stream,
} from "../src/morphisms/openai_chat.js";
import {
  luv_send_to_openai_http_request,
  openai_http_response_to_luv_reply,
  openai_http_stream_to_luv_stream,
  type HTTPRequest,
  type HTTPResponse,
  type OpenAIClientConfig,
} from "../src/transport/openai_chat.js";

function encodeHTTPRequest(req: HTTPRequest): unknown {
  return {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: req.body,
  };
}

// SPEC root (assumes the impl lives at impl/typescript/ inside the repo).
const SPEC_ROOT = join(import.meta.dir, "..", "..", "..", "spec");

// Registry of arrows the bench knows how to drive. Each entry returns
// the canonical output BYTES (string) for a parsed input value.
type ArrowFn = (input: unknown) => string;

const arrows: Record<string, ArrowFn> = {
  consume_luv_stream_reply: (input) =>
    stringify(encodeReply(consume_luv_stream_reply(input as never))),

  produce_luv_stream_reply: (input) =>
    stringify(encodeStreamReply(produce_luv_stream_reply(input as never))),

  validate_luv_conversation: (input) =>
    stringify(encodeValidationResult(validate_luv_conversation(input))),

  luv_conversation_to_openai_request: (input) =>
    stringify(
      luv_conversation_to_openai_request(input as never, {
        model: "gpt-4o-mini",
      }),
    ),

  openai_response_to_luv_reply: (input) =>
    stringify(encodeReply(openai_response_to_luv_reply(input))),

  openai_stream_to_luv_stream: (input) =>
    stringify(encodeStreamReply(openai_stream_to_luv_stream(input as never))),

  luv_send_to_openai_http_request: (input) => {
    const wrapped = input as {
      conversation: never;
      opts: never;
      config: OpenAIClientConfig;
    };
    return stringify(
      encodeHTTPRequest(
        luv_send_to_openai_http_request(
          wrapped.conversation,
          wrapped.opts,
          wrapped.config,
        ),
      ),
    );
  },

  openai_http_response_to_luv_reply: (input) =>
    stringify(
      encodeReply(openai_http_response_to_luv_reply(input as HTTPResponse)),
    ),

  openai_http_stream_to_luv_stream: (input) =>
    stringify(
      encodeStreamReply(
        openai_http_stream_to_luv_stream(input as HTTPResponse),
      ),
    ),
};

// Walk a cases root (either spec/cases or spec/morphisms/*/cases) and
// return [{arrowName, caseSlug, dir}, ...].
function discoverCases(
  casesRoot: string,
): Array<{ arrow: string; slug: string; dir: string }> {
  const out: Array<{ arrow: string; slug: string; dir: string }> = [];
  if (!safeIsDir(casesRoot)) return out;
  for (const arrowName of readdirSync(casesRoot)) {
    const arrowDir = join(casesRoot, arrowName);
    if (!safeIsDir(arrowDir)) continue;
    for (const slug of readdirSync(arrowDir)) {
      const slugDir = join(arrowDir, slug);
      if (!safeIsDir(slugDir)) continue;
      if (!fileExists(join(slugDir, "input.json"))) continue;
      if (!fileExists(join(slugDir, "expected.json"))) continue;
      out.push({ arrow: arrowName, slug, dir: slugDir });
    }
  }
  return out;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readBytes(p: string): string {
  // Read as UTF-8 string; strip a single trailing newline (Section 3
  // permits a single trailing \n at top-level file boundary).
  let s = readFileSync(p, "utf8");
  if (s.endsWith("\n")) s = s.slice(0, -1);
  return s;
}

// Universal cases: spec/cases/<arrow>/<slug>/
const universalCases = discoverCases(join(SPEC_ROOT, "cases"));

// Per-morphism cases: spec/morphisms/<provider>/cases/<arrow>/<slug>/
function discoverMorphismCases(): Array<{
  morphism: string;
  arrow: string;
  slug: string;
  dir: string;
}> {
  const morphismsRoot = join(SPEC_ROOT, "morphisms");
  const out: Array<{
    morphism: string;
    arrow: string;
    slug: string;
    dir: string;
  }> = [];
  if (!safeIsDir(morphismsRoot)) return out;
  for (const morphism of readdirSync(morphismsRoot)) {
    const casesRoot = join(morphismsRoot, morphism, "cases");
    for (const c of discoverCases(casesRoot)) {
      out.push({ morphism, ...c });
    }
  }
  return out;
}

const morphismCases = discoverMorphismCases();

describe("universal bench cases", () => {
  for (const c of universalCases) {
    test(`${c.arrow}/${c.slug}`, () => {
      const arrow = arrows[c.arrow];
      if (!arrow) {
        throw new Error(`No registered arrow for ${c.arrow}`);
      }
      const input = JSON.parse(readFileSync(join(c.dir, "input.json"), "utf8"));
      const actual = arrow(input);
      const expected = readBytes(join(c.dir, "expected.json"));
      expect(actual).toBe(expected);
    });
  }
});

describe("openai_chat morphism cases", () => {
  for (const c of morphismCases) {
    test(`${c.morphism}/${c.arrow}/${c.slug}`, () => {
      const arrow = arrows[c.arrow];
      if (!arrow) {
        throw new Error(`No registered arrow for ${c.arrow}`);
      }
      const input = JSON.parse(readFileSync(join(c.dir, "input.json"), "utf8"));
      const actual = arrow(input);
      const expected = readBytes(join(c.dir, "expected.json"));
      expect(actual).toBe(expected);
    });
  }
});
