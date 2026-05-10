// DX-3: stream.text() yields just text deltas.

import { test, expect } from "bun:test";
import { sendStream } from "../src/send_stream.ts";

const FIXTURE_011 = "/workspaces/luv/core/fixtures/openai/011_stream_basic/response.sse.txt";

async function loadFixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

function makeMockSseFetch(body: Uint8Array): typeof fetch {
  const impl = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
    return new Response(stream as unknown as BodyInit, { status: 200 });
  };
  return impl as typeof fetch;
}

test("stream.text(): yields only text deltas, concatenated to full text", async () => {
  const fixture = await loadFixture(FIXTURE_011);
  const stream = sendStream(
    {
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
    },
    { fetch: makeMockSseFetch(fixture) },
  );

  let collected = "";
  for await (const text of stream.text()) {
    collected += text;
  }
  expect(collected).toBe("1, 2, 3, 4, 5");
});
