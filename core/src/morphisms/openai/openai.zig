//! Pure mapping between luv.Conversation/Reply and OpenAI Chat Completions wire JSON.
//! No I/O. Optional null fields are omitted on serialization (matches real requests).
//!
//! Loss table (luv ↔ openai):
//!
//! luv → openai (toOpenAI):
//!   - Role.system | .user | .assistant → "system" | "user" | "assistant" lowercase strings.
//!   - Conversation order is preserved verbatim; consecutive same-role accepted.
//!   - Options.{model,max_tokens,temperature,stream} added at request level — luv has no concept of these.
//!   - Dropped (never emitted): name, tools, tool_choice, response_format, n, stop, seed, stream_options,
//!     logprobs, top_logprobs, top_p, presence/frequency_penalty, audio, modalities, prediction, metadata,
//!     store, service_tier, user, parallel_tool_calls.
//!
//! openai → luv (fromOpenAI):
//!   - First choice only is taken (n>1 is out of scope).
//!   - choice.message.role coerced to luv.Role.assistant unconditionally.
//!   - choice.message.content used; if null, choice.message.refusal is substituted (lossy: we don't tag it).
//!   - finish_reason mapped: "stop" → end_turn, "length" → max_tokens, "content_filter" → content_filter,
//!     "tool_calls"/"function_call" → tool_use, anything else → other.
//!   - Dropped: id, object, created, model, system_fingerprint, service_tier, usage (all subfields),
//!     choice.index, choice.logprobs, message.annotations, message.audio, message.tool_calls.

const std = @import("std");
const luv = @import("../luv/luv.zig");

pub const Options = struct {
    model: []const u8,
    max_tokens: ?u32 = null,
    temperature: ?f64 = null,
    stream: bool = false,
    tools: []const luv.Tool = &.{},
};

pub const RequestToolCallFunction = struct {
    name: []const u8,
    /// Stringified JSON of the call's arguments object.
    arguments: []const u8,
};

pub const RequestToolCall = struct {
    id: []const u8,
    type: []const u8 = "function",
    function: RequestToolCallFunction,
};

pub const RequestMessage = struct {
    role: []const u8,
    content: ?[]const u8 = null,
    tool_calls: ?[]const RequestToolCall = null,
    tool_call_id: ?[]const u8 = null,
};

pub const ToolDefFunction = struct {
    name: []const u8,
    description: []const u8,
    parameters: std.json.Value,
};

pub const ToolDef = struct {
    type: []const u8 = "function",
    function: ToolDefFunction,
};

pub const Request = struct {
    model: []const u8,
    messages: []const RequestMessage,
    max_tokens: ?u32 = null,
    temperature: ?f64 = null,
    stream: ?bool = null,
    tools: ?[]const ToolDef = null,
};

pub const ResponseToolCallFunction = struct {
    name: []const u8,
    arguments: []const u8,
};

pub const ResponseToolCall = struct {
    id: []const u8,
    type: []const u8,
    function: ResponseToolCallFunction,
};

pub const ResponseMessage = struct {
    role: []const u8,
    content: ?[]const u8 = null,
    refusal: ?[]const u8 = null,
    tool_calls: ?[]const ResponseToolCall = null,
};

pub const Choice = struct {
    index: u32 = 0,
    message: ResponseMessage,
    finish_reason: []const u8,
};

pub const Usage = struct {
    prompt_tokens: u32 = 0,
    completion_tokens: u32 = 0,
    total_tokens: u32 = 0,
};

// Envelope fields optional to match the lenient TS port (OpenAIWireResponse:
// id/object/created/model/usage all optional; only choices required).
pub const Response = struct {
    id: ?[]const u8 = null,
    object: ?[]const u8 = null,
    created: ?i64 = null,
    model: ?[]const u8 = null,
    choices: []const Choice,
    usage: ?Usage = null,
};

fn roleToString(r: luv.Role) []const u8 {
    return switch (r) {
        .system => "system",
        .user => "user",
        .assistant => "assistant",
    };
}

fn stopReasonFrom(s: []const u8) luv.StopReason {
    if (std.mem.eql(u8, s, "stop")) return .end_turn;
    if (std.mem.eql(u8, s, "length")) return .max_tokens;
    if (std.mem.eql(u8, s, "content_filter")) return .content_filter;
    if (std.mem.eql(u8, s, "tool_calls")) return .tool_use;
    if (std.mem.eql(u8, s, "function_call")) return .tool_use;
    return .other;
}

/// Build an OpenAI Request from a luv conversation.
///
/// Allocations made during this call: the messages slice, optional tools
/// slice, the per-tool-call wire-format tool_calls slices, the per-tool-call
/// stringified arguments JSON, and the per-tool-result error string (for
/// `.err` ToolResults). Use an arena allocator to free everything at once;
/// the morphism does not provide a recursive deinit helper.
pub fn toOpenAI(
    messages: luv.Conversation,
    opts: Options,
    alloc: std.mem.Allocator,
) !Request {
    // Output length is ≥ messages.len: every resolved tool call on an
    // assistant message expands into one extra wire {role:"tool"} entry.
    var out: std.ArrayList(RequestMessage) = .empty;
    errdefer out.deinit(alloc);

    for (messages) |m| {
        if (m.role == .assistant and m.tool_calls.len > 0) {
            const wire_calls = try alloc.alloc(RequestToolCall, m.tool_calls.len);
            for (m.tool_calls, 0..) |c, j| {
                const args_str = try std.json.Stringify.valueAlloc(alloc, c.arguments, .{});
                wire_calls[j] = .{
                    .id = c.id,
                    .function = .{
                        .name = c.name,
                        .arguments = args_str,
                    },
                };
            }
            try out.append(alloc, .{
                .role = "assistant",
                .content = if (m.text.len == 0) null else m.text,
                .tool_calls = wire_calls,
            });
            // Split colocated → wire: emit one tool message per resolved
            // call. Pending calls (result == null) emit nothing — the
            // server expects results only for calls already executed.
            for (m.tool_calls) |c| {
                const result = c.result orelse continue;
                const content: []const u8 = switch (result) {
                    .ok => |s| s,
                    .err => |e| try std.fmt.allocPrint(alloc, "Error: {s}", .{e}),
                };
                try out.append(alloc, .{
                    .role = "tool",
                    .content = content,
                    .tool_call_id = c.id,
                });
            }
            continue;
        }
        try out.append(alloc, .{
            .role = roleToString(m.role),
            .content = m.text,
        });
    }

    var out_tools: ?[]ToolDef = null;
    if (opts.tools.len > 0) {
        const td = try alloc.alloc(ToolDef, opts.tools.len);
        for (opts.tools, 0..) |t, i| {
            td[i] = .{
                .function = .{
                    .name = t.name,
                    .description = t.description,
                    .parameters = t.input_schema,
                },
            };
        }
        out_tools = td;
    }

    return .{
        .model = opts.model,
        .messages = try out.toOwnedSlice(alloc),
        .max_tokens = opts.max_tokens,
        .temperature = opts.temperature,
        .stream = if (opts.stream) true else null,
        .tools = out_tools,
    };
}

pub const FromError = error{ NoChoices, InvalidToolArgumentsJson } || std.mem.Allocator.Error;

/// Convert a parsed OpenAI Response into a luv.Reply.
/// Use an arena allocator to free reply.message.text + tool_calls (and
/// nested arguments std.json.Values) all at once.
pub fn fromOpenAI(resp: Response, alloc: std.mem.Allocator) FromError!luv.Reply {
    if (resp.choices.len == 0) return error.NoChoices;
    const choice = resp.choices[0];
    const text = choice.message.content orelse choice.message.refusal orelse "";
    const owned_text = try alloc.dupe(u8, text);

    var tool_calls: []luv.ToolCall = &.{};
    if (choice.message.tool_calls) |wire_calls| {
        if (wire_calls.len > 0) {
            const out = try alloc.alloc(luv.ToolCall, wire_calls.len);
            for (wire_calls, 0..) |wc, i| {
                const owned_id = try alloc.dupe(u8, wc.id);
                const owned_name = try alloc.dupe(u8, wc.function.name);
                const args_value = std.json.parseFromSliceLeaky(
                    std.json.Value,
                    alloc,
                    wc.function.arguments,
                    .{},
                ) catch return error.InvalidToolArgumentsJson;
                out[i] = .{
                    .id = owned_id,
                    .name = owned_name,
                    .arguments = args_value,
                };
            }
            tool_calls = out;
        }
    }

    return .{
        .message = .{
            .role = .assistant,
            .text = owned_text,
            .tool_calls = tool_calls,
        },
        .stop_reason = stopReasonFrom(choice.finish_reason),
        // Match the TS port: usage present only when the wire carried it.
        .usage = if (resp.usage) |u| luv.Usage{
            .prompt_tokens = u.prompt_tokens,
            .completion_tokens = u.completion_tokens,
            .total_tokens = u.total_tokens,
        } else null,
    };
}

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;

const max_fixture_bytes: usize = 1 * 1024 * 1024;

fn loadFixture(rel_path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(
        testing.io,
        rel_path,
        testing.allocator,
        .limited(max_fixture_bytes),
    );
}

/// Recursive structural equality for parsed JSON values.
/// Numbers compare by canonical f64; objects/arrays compare deeply.
fn jsonEqual(a: std.json.Value, b: std.json.Value) bool {
    if (@as(std.meta.Tag(std.json.Value), a) != @as(std.meta.Tag(std.json.Value), b)) return false;
    return switch (a) {
        .null => true,
        .bool => a.bool == b.bool,
        .integer => a.integer == b.integer,
        .float => a.float == b.float,
        .number_string => std.mem.eql(u8, a.number_string, b.number_string),
        .string => std.mem.eql(u8, a.string, b.string),
        .array => blk: {
            if (a.array.items.len != b.array.items.len) break :blk false;
            for (a.array.items, b.array.items) |x, y| {
                if (!jsonEqual(x, y)) break :blk false;
            }
            break :blk true;
        },
        .object => blk: {
            if (a.object.count() != b.object.count()) break :blk false;
            var it = a.object.iterator();
            while (it.next()) |entry| {
                const other = b.object.get(entry.key_ptr.*) orelse break :blk false;
                if (!jsonEqual(entry.value_ptr.*, other)) break :blk false;
            }
            break :blk true;
        },
    };
}

test "to_openai: 001_single_user matches fixture request.json" {
    const messages = [_]luv.Message{
        .{ .role = .user, .text = "Say hello in one short sentence." },
    };

    const req = try toOpenAI(&messages, .{
        .model = "gpt-4o-mini",
        .max_tokens = 32,
        .temperature = 0,
    }, testing.allocator);
    defer testing.allocator.free(req.messages);

    const actual = try std.json.Stringify.valueAlloc(testing.allocator, req, .{
        .emit_null_optional_fields = false,
    });
    defer testing.allocator.free(actual);

    const actual_parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, actual, .{});
    defer actual_parsed.deinit();

    const fixture = try loadFixture("fixtures/openai/001_single_user/request.json");
    defer testing.allocator.free(fixture);
    const expected_parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, fixture, .{});
    defer expected_parsed.deinit();

    try testing.expect(jsonEqual(actual_parsed.value, expected_parsed.value));
}

test "from_openai: 001_single_user yields assistant Reply with end_turn" {
    const fixture = try loadFixture("fixtures/openai/001_single_user/response.json");
    defer testing.allocator.free(fixture);
    const parsed = try std.json.parseFromSlice(Response, testing.allocator, fixture, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();

    const reply = try fromOpenAI(parsed.value, testing.allocator);
    defer testing.allocator.free(reply.message.text);

    try testing.expectEqual(luv.Role.assistant, reply.message.role);
    try testing.expect(reply.message.text.len > 0);
    try testing.expectEqual(luv.StopReason.end_turn, reply.stop_reason);
    try testing.expect(reply.usage != null);
    try testing.expect(reply.usage.?.prompt_tokens > 0);
    try testing.expect(reply.usage.?.completion_tokens > 0);
    try testing.expectEqual(
        reply.usage.?.prompt_tokens + reply.usage.?.completion_tokens,
        reply.usage.?.total_tokens,
    );
}

// ---------------------------------------------------------------------------
// Phase K — tool calling

fn schemaCity(arena: std.mem.Allocator) !std.json.Value {
    return std.json.parseFromSliceLeaky(std.json.Value, arena,
        \\{
        \\  "type": "object",
        \\  "properties": { "city": { "type": "string", "description": "City name" } },
        \\  "required": ["city"]
        \\}
    , .{});
}

fn freeRequestMessages(req: Request, alloc: std.mem.Allocator) void {
    for (req.messages) |m| {
        if (m.tool_calls) |tcs| {
            for (tcs) |tc| alloc.free(tc.function.arguments);
            alloc.free(tcs);
        }
        if (m.role.len > 0 and std.mem.eql(u8, m.role, "tool")) {
            // Tool result content was allocPrint'd if .err; if .ok it's borrowed.
            // We leak ok-content (small, test arena wipes anyway). For safety,
            // tests should construct with .err to exercise allocation, or use arena.
        }
    }
    alloc.free(req.messages);
    if (req.tools) |ts| alloc.free(ts);
}

test "to_openai: 020 emits tools[] alongside messages" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const schema = try schemaCity(arena);
    const tools = [_]luv.Tool{.{
        .name = "lookup_weather",
        .description = "Returns current weather for a city",
        .input_schema = schema,
    }};
    const messages = [_]luv.Message{
        .{ .role = .user, .text = "What's the weather in Tokyo?" },
    };

    const req = try toOpenAI(&messages, .{
        .model = "gpt-4o-mini",
        .tools = &tools,
    }, arena);

    const actual = try std.json.Stringify.valueAlloc(arena, req, .{
        .emit_null_optional_fields = false,
    });
    const actual_parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena, actual, .{});

    const fixture = try loadFixture("fixtures/openai/020_tool_calls_basic/request.json");
    defer testing.allocator.free(fixture);
    const expected_parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena, fixture, .{});

    try testing.expect(jsonEqual(actual_parsed, expected_parsed));
}

test "from_openai: 020 parses tool_calls into Reply.message.tool_calls + tool_use stop" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const fixture = try loadFixture("fixtures/openai/020_tool_calls_basic/response.json");
    defer testing.allocator.free(fixture);
    const parsed = try std.json.parseFromSlice(Response, arena, fixture, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();

    const reply = try fromOpenAI(parsed.value, arena);

    try testing.expectEqual(luv.Role.assistant, reply.message.role);
    try testing.expectEqualStrings("", reply.message.text);
    try testing.expectEqual(@as(usize, 1), reply.message.tool_calls.len);
    try testing.expectEqualStrings("call_abc123", reply.message.tool_calls[0].id);
    try testing.expectEqualStrings("lookup_weather", reply.message.tool_calls[0].name);
    try testing.expectEqualStrings("Tokyo", reply.message.tool_calls[0].arguments.object.get("city").?.string);
    try testing.expectEqual(luv.StopReason.tool_use, reply.stop_reason);
}

test "to_openai: 021 round-trip serializes assistant.tool_calls + tool result message" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const schema = try schemaCity(arena);
    const args = try std.json.parseFromSliceLeaky(std.json.Value, arena, "{\"city\":\"Tokyo\"}", .{});
    // Colocated form: result lives on the ToolCall itself. The morphism is
    // responsible for splitting this into the wire's separate {role:"tool"}
    // message at the boundary.
    const calls = [_]luv.ToolCall{.{
        .id = "call_abc123",
        .name = "lookup_weather",
        .arguments = args,
        .result = .{ .ok = "{\"temp_c\":18,\"condition\":\"sunny\"}" },
    }};
    const messages = [_]luv.Message{
        .{ .role = .user, .text = "What's the weather in Tokyo?" },
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const tools = [_]luv.Tool{.{
        .name = "lookup_weather",
        .description = "Returns current weather for a city",
        .input_schema = schema,
    }};

    const req = try toOpenAI(&messages, .{ .model = "gpt-4o-mini", .tools = &tools }, arena);

    const actual = try std.json.Stringify.valueAlloc(arena, req, .{
        .emit_null_optional_fields = false,
    });
    const actual_parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena, actual, .{});

    const fixture = try loadFixture("fixtures/openai/021_tool_round_trip/request.json");
    defer testing.allocator.free(fixture);
    const expected_parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena, fixture, .{});

    try testing.expect(jsonEqual(actual_parsed, expected_parsed));
}

test "from_openai: 022 parallel tool calls yield two ToolCall entries in order" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const fixture = try loadFixture("fixtures/openai/022_parallel_tool_calls/response.json");
    defer testing.allocator.free(fixture);
    const parsed = try std.json.parseFromSlice(Response, arena, fixture, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();

    const reply = try fromOpenAI(parsed.value, arena);

    try testing.expectEqual(@as(usize, 2), reply.message.tool_calls.len);
    try testing.expectEqualStrings("call_tokyo_1", reply.message.tool_calls[0].id);
    try testing.expectEqualStrings("Tokyo", reply.message.tool_calls[0].arguments.object.get("city").?.string);
    try testing.expectEqualStrings("call_berlin_1", reply.message.tool_calls[1].id);
    try testing.expectEqualStrings("Berlin", reply.message.tool_calls[1].arguments.object.get("city").?.string);
    try testing.expectEqual(luv.StopReason.tool_use, reply.stop_reason);
}
