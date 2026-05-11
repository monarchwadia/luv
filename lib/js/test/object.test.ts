// Item A: generateObject — typed structured output via OpenAI's
// response_format: json_schema.

import { test, expect } from "bun:test";
import { generateObject } from "../src/object.ts";

function makeJsonFetch(replyText: string, status = 200): typeof fetch {
  const impl = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const wire = {
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: replyText },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    };
    return new Response(JSON.stringify(wire), { status });
  };
  return impl as typeof fetch;
}

test("generateObject: returns typed object matching the schema", async () => {
  const result = await generateObject(
    {
      apiKey: "sk",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "Give me a recipe" }],
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          ingredients: { type: "array", items: { type: "string" } },
        },
        required: ["name", "ingredients"],
      },
    },
    {
      fetch: makeJsonFetch(
        JSON.stringify({ name: "Lasagna", ingredients: ["pasta", "cheese"] }),
      ),
    },
  );
  expect(result.object.name).toBe("Lasagna");
  expect(result.object.ingredients).toEqual(["pasta", "cheese"]);
  expect(result.stopReason).toBe("end_turn");
  expect(result.usage?.totalTokens).toBe(20);
});

test("generateObject: outgoing request carries response_format with the schema", async () => {
  let captured: { body: string } | null = null;
  const captureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = { body: typeof init?.body === "string" ? init.body : "" };
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"x":1}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  await generateObject(
    {
      apiKey: "sk",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
      schema: {
        type: "object",
        properties: { x: { type: "number" } },
        required: ["x"],
      },
    },
    { fetch: captureFetch },
  );

  expect(captured).not.toBeNull();
  const parsed = JSON.parse(captured!.body);
  expect(parsed.response_format).toBeDefined();
  expect(parsed.response_format.type).toBe("json_schema");
  expect(parsed.response_format.json_schema.strict).toBe(true);
  expect(parsed.response_format.json_schema.schema.properties.x.type).toBe("number");
});

test("generateObject: throws when the model returns invalid JSON", async () => {
  await expect(
    generateObject(
      {
        apiKey: "sk",
        model: "gpt-4o-mini",
        conversation: [{ role: "user", text: "x" }],
        schema: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      },
      { fetch: makeJsonFetch("not actually json") },
    ),
  ).rejects.toThrow();
});

test("generateObject: validates the result against the schema (missing required field)", async () => {
  await expect(
    generateObject(
      {
        apiKey: "sk",
        model: "gpt-4o-mini",
        conversation: [{ role: "user", text: "x" }],
        schema: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      },
      { fetch: makeJsonFetch('{"y":1}') },
    ),
  ).rejects.toThrow(/x/);
});

test("generateObject: nested object schemas are typed correctly", async () => {
  const result = await generateObject(
    {
      apiKey: "sk",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
      schema: {
        type: "object",
        properties: {
          recipe: {
            type: "object",
            properties: {
              name: { type: "string" },
              steps: { type: "array", items: { type: "string" } },
            },
            required: ["name", "steps"],
          },
        },
        required: ["recipe"],
      },
    },
    {
      fetch: makeJsonFetch(
        JSON.stringify({ recipe: { name: "Pancakes", steps: ["mix", "cook"] } }),
      ),
    },
  );
  // recipe.name and recipe.steps are typed via InferSchema
  expect(result.object.recipe.name).toBe("Pancakes");
  expect(result.object.recipe.steps).toEqual(["mix", "cook"]);
});

import { GenerateObjectError } from "../src/object.ts";
import { RateLimitError, AuthError } from "../src/errors.ts";

test("generateObject: deeply injects additionalProperties:false on every nested object", async () => {
  // Regression: OpenAI strict mode rejects requests where any object node
  // is missing additionalProperties:false. Our injection must walk recursively.
  let captured: { body: string } | null = null;
  const captureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = { body: typeof init?.body === "string" ? init.body : "" };
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion", created: 1, model: "x",
      choices: [{ index: 0, message: { role: "assistant", content: '{"a":{"b":{"c":"x"}}}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await generateObject(
    {
      apiKey: "sk", model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
      schema: {
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: {
              b: {
                type: "object",
                properties: { c: { type: "string" } },
                required: ["c"],
              },
            },
            required: ["b"],
          },
        },
        required: ["a"],
      },
    },
    { fetch: captureFetch },
  );

  const sent = JSON.parse(captured!.body);
  const schema = sent.response_format.json_schema.schema;
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.a.additionalProperties).toBe(false);
  expect(schema.properties.a.properties.b.additionalProperties).toBe(false);
});

test("generateObject: injects additionalProperties:false on objects nested in array items", async () => {
  let captured: { body: string } | null = null;
  const captureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = { body: typeof init?.body === "string" ? init.body : "" };
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion", created: 1, model: "x",
      choices: [{ index: 0, message: { role: "assistant", content: '{"items":[]}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await generateObject(
    {
      apiKey: "sk", model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
        required: ["items"],
      },
    },
    { fetch: captureFetch },
  );

  const sent = JSON.parse(captured!.body);
  expect(sent.response_format.json_schema.schema.properties.items.items.additionalProperties).toBe(false);
});

test("generateObject: respects user-supplied additionalProperties value (does not overwrite)", async () => {
  let captured: { body: string } | null = null;
  const captureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = { body: typeof init?.body === "string" ? init.body : "" };
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion", created: 1, model: "x",
      choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await generateObject(
    {
      apiKey: "sk", model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
      schema: {
        type: "object",
        additionalProperties: true,  // explicit choice; respect it
        properties: {},
      },
    },
    { fetch: captureFetch },
  );

  const sent = JSON.parse(captured!.body);
  expect(sent.response_format.json_schema.schema.additionalProperties).toBe(true);
});

test("generateObject: HTTP errors propagate as typed subclasses (RateLimitError)", async () => {
  const errFetch = (async () =>
    new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: 429,
      headers: { "retry-after": "10" },
    })) as unknown as typeof fetch;

  const promise = generateObject(
    {
      apiKey: "sk", model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
      schema: { type: "object", properties: {}, required: [] },
    },
    { fetch: errFetch },
  );

  await expect(promise).rejects.toBeInstanceOf(RateLimitError);
});

test("generateObject: HTTP errors propagate as AuthError on 401", async () => {
  const errFetch = (async () =>
    new Response("", { status: 401 })) as unknown as typeof fetch;

  await expect(
    generateObject(
      {
        apiKey: "sk", model: "gpt-4o-mini",
        conversation: [{ role: "user", text: "x" }],
        schema: { type: "object", properties: {}, required: [] },
      },
      { fetch: errFetch },
    ),
  ).rejects.toBeInstanceOf(AuthError);
});

test("generateObject: schemaName overrides the default 'result' name", async () => {
  let captured: { body: string } | null = null;
  const captureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = { body: typeof init?.body === "string" ? init.body : "" };
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion", created: 1, model: "x",
      choices: [{ index: 0, message: { role: "assistant", content: '{"x":1}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await generateObject(
    {
      apiKey: "sk", model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
      schemaName: "MyCustomName",
      schema: {
        type: "object",
        properties: { x: { type: "number" } },
        required: ["x"],
      },
    },
    { fetch: captureFetch },
  );

  const sent = JSON.parse(captured!.body);
  expect(sent.response_format.json_schema.name).toBe("MyCustomName");
});

test("generateObject: usage on result is populated from the wire response", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({
      id: "x", object: "chat.completion", created: 1, model: "x",
      choices: [{ index: 0, message: { role: "assistant", content: '{"x":1}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
    }), { status: 200 })) as unknown as typeof fetch;

  const r = await generateObject(
    {
      apiKey: "sk", model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
      schema: {
        type: "object",
        properties: { x: { type: "number" } },
        required: ["x"],
      },
    },
    { fetch: fetchImpl },
  );

  expect(r.usage?.totalTokens).toBe(75);
});

test("GenerateObjectError is the error class for malformed JSON / schema mismatch", async () => {
  await expect(
    generateObject(
      {
        apiKey: "sk", model: "gpt-4o-mini",
        conversation: [{ role: "user", text: "x" }],
        schema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      },
      { fetch: makeJsonFetch("garbage") },
    ),
  ).rejects.toBeInstanceOf(GenerateObjectError);
});
