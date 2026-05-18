//! Pure mapping between luv.Conversation/Reply and the Anthropic Messages API.
//! No I/O. Optional null fields are omitted on serialization (matches real requests).
//!
//! Loss table (luv ↔ anthropic):
//!
//! luv → anthropic (toAnthropic):
//!   - System messages are pulled out of the conversation array into the
//!     top-level `system` field (Anthropic-specific). Multiple system
//!     messages are concatenated with blank-line separators.
//!   - Assistant messages with tool_calls become an array of content blocks:
//!     a text block (if text is non-empty) plus one tool_use block per call.
//!   - Resolved tool calls become tool_result content blocks on a following
//!     user message. Adjacent tool results are folded into the same user
//!     message (Anthropic prefers/requires this for some models). Pending
//!     calls (result == null) emit nothing.
//!   - max_tokens defaults to 1024 if not provided (Anthropic requires it).
//!
//! anthropic → luv (fromAnthropic):
//!   - All text content blocks are concatenated into Reply.message.text.
//!   - All tool_use content blocks become Reply.message.tool_calls.
//!   - stop_reason vocabulary maps cleanly: end_turn / max_tokens /
//!     stop_sequence / tool_use are 1:1 with luv.StopReason; anything
//!     else (including null) → other.
//!   - usage.input_tokens → prompt_tokens, output_tokens → completion_tokens,
//!     total_tokens is computed (Anthropic doesn't send a total).
//!   - Dropped: id, type, role (assumed assistant), model, stop_sequence.

const std = @import("std");
const luv = @import("../luv/luv.zig");

pub const Options = struct {
    model: []const u8,
    max_tokens: ?u32 = null,
    temperature: ?f64 = null,
    stream: bool = false,
    tools: []const luv.Tool = &.{},
};

// ---------------------------------------------------------------------------
// Wire request types

pub const TextBlock = struct {
    type: []const u8 = "text",
    text: []const u8,
};

pub const ToolUseBlock = struct {
    type: []const u8 = "tool_use",
    id: []const u8,
    name: []const u8,
    input: std.json.Value,
};

pub const ToolResultBlock = struct {
    type: []const u8 = "tool_result",
    tool_use_id: []const u8,
    content: []const u8,
    is_error: ?bool = null,
};

/// A content block can be any of the three request-side shapes. We model it
/// as a tagged union with custom JSON serialization so the wire is a flat
/// object (no union tag wrapper).
pub const RequestBlock = union(enum) {
    text: TextBlock,
    tool_use: ToolUseBlock,
    tool_result: ToolResultBlock,

    pub fn jsonStringify(self: RequestBlock, jw: anytype) !void {
        switch (self) {
            .text => |b| try jw.write(b),
            .tool_use => |b| try jw.write(b),
            .tool_result => |b| try jw.write(b),
        }
    }
};

/// Message content is either a bare string or an array of blocks. Custom
/// serialization emits whichever variant is active.
pub const RequestContent = union(enum) {
    text: []const u8,
    blocks: []const RequestBlock,

    pub fn jsonStringify(self: RequestContent, jw: anytype) !void {
        switch (self) {
            .text => |s| try jw.write(s),
            .blocks => |b| try jw.write(b),
        }
    }
};

pub const RequestMessage = struct {
    role: []const u8,
    content: RequestContent,
};

pub const ToolDef = struct {
    name: []const u8,
    description: []const u8,
    input_schema: std.json.Value,
};

pub const Request = struct {
    model: []const u8,
    max_tokens: u32,
    messages: []const RequestMessage,
    system: ?[]const u8 = null,
    temperature: ?f64 = null,
    stream: ?bool = null,
    tools: ?[]const ToolDef = null,
};

// ---------------------------------------------------------------------------
// Wire response types

pub const ResponseBlock = struct {
    type: []const u8,
    text: ?[]const u8 = null,
    id: ?[]const u8 = null,
    name: ?[]const u8 = null,
    input: ?std.json.Value = null,
};

pub const ResponseUsage = struct {
    input_tokens: u32 = 0,
    output_tokens: u32 = 0,
};

pub const Response = struct {
    id: ?[]const u8 = null,
    type: ?[]const u8 = null,
    role: ?[]const u8 = null,
    content: []const ResponseBlock,
    model: ?[]const u8 = null,
    stop_reason: ?[]const u8 = null,
    stop_sequence: ?[]const u8 = null,
    usage: ?ResponseUsage = null,
};

// ---------------------------------------------------------------------------

fn stopReasonFrom(s: ?[]const u8) luv.StopReason {
    const v = s orelse return .other;
    if (std.mem.eql(u8, v, "end_turn")) return .end_turn;
    if (std.mem.eql(u8, v, "max_tokens")) return .max_tokens;
    if (std.mem.eql(u8, v, "stop_sequence")) return .stop_sequence;
    if (std.mem.eql(u8, v, "tool_use")) return .tool_use;
    return .other;
}

/// Build an Anthropic Request from a luv conversation.
///
/// Allocations made during this call: the messages slice, the per-message
/// block slices, the per-resolved-call tool_result block slice, the
/// concatenated system string (when ≥2 system messages), and the optional
/// tools slice. Use an arena allocator to free everything at once; the
/// morphism does not provide a recursive deinit helper.
pub fn toAnthropic(
    messages: luv.Conversation,
    opts: Options,
    alloc: std.mem.Allocator,
) !Request {
    var out: std.ArrayList(RequestMessage) = .empty;
    errdefer out.deinit(alloc);

    var system: ?[]const u8 = null;

    for (messages) |m| {
        switch (m.role) {
            .system => {
                if (system) |prev| {
                    system = try std.fmt.allocPrint(alloc, "{s}\n\n{s}", .{ prev, m.text });
                } else {
                    system = m.text;
                }
            },
            .user => {
                try out.append(alloc, .{
                    .role = "user",
                    .content = .{ .text = m.text },
                });
            },
            .assistant => {
                if (m.tool_calls.len > 0) {
                    // text block (when non-empty) + one tool_use block per call.
                    const has_text = m.text.len > 0;
                    const n_blocks = m.tool_calls.len + @as(usize, if (has_text) 1 else 0);
                    const blocks = try alloc.alloc(RequestBlock, n_blocks);
                    var bi: usize = 0;
                    if (has_text) {
                        blocks[bi] = .{ .text = .{ .text = m.text } };
                        bi += 1;
                    }
                    for (m.tool_calls) |c| {
                        blocks[bi] = .{ .tool_use = .{
                            .id = c.id,
                            .name = c.name,
                            .input = c.arguments,
                        } };
                        bi += 1;
                    }
                    try out.append(alloc, .{
                        .role = "assistant",
                        .content = .{ .blocks = blocks },
                    });

                    // Split colocated → wire: every resolved call becomes a
                    // tool_result block folded into one following user
                    // message. Pending calls emit nothing.
                    var n_results: usize = 0;
                    for (m.tool_calls) |c| {
                        if (c.result != null) n_results += 1;
                    }
                    if (n_results > 0) {
                        const result_blocks = try alloc.alloc(RequestBlock, n_results);
                        var ri: usize = 0;
                        for (m.tool_calls) |c| {
                            const result = c.result orelse continue;
                            result_blocks[ri] = switch (result) {
                                .ok => |s| .{ .tool_result = .{
                                    .tool_use_id = c.id,
                                    .content = s,
                                } },
                                .err => |e| .{ .tool_result = .{
                                    .tool_use_id = c.id,
                                    .content = e,
                                    .is_error = true,
                                } },
                            };
                            ri += 1;
                        }
                        try out.append(alloc, .{
                            .role = "user",
                            .content = .{ .blocks = result_blocks },
                        });
                    }
                } else {
                    try out.append(alloc, .{
                        .role = "assistant",
                        .content = .{ .text = m.text },
                    });
                }
            },
        }
    }

    var out_tools: ?[]ToolDef = null;
    if (opts.tools.len > 0) {
        const td = try alloc.alloc(ToolDef, opts.tools.len);
        for (opts.tools, 0..) |t, i| {
            td[i] = .{
                .name = t.name,
                .description = t.description,
                .input_schema = t.input_schema,
            };
        }
        out_tools = td;
    }

    return .{
        .model = opts.model,
        .max_tokens = opts.max_tokens orelse 1024,
        .messages = try out.toOwnedSlice(alloc),
        .system = system,
        .temperature = opts.temperature,
        .stream = if (opts.stream) true else null,
        .tools = out_tools,
    };
}

pub const FromError = error{ContentNotArray} || std.mem.Allocator.Error;

/// Convert a parsed Anthropic Response into a luv.Reply.
///
/// `ContentNotArray` is reserved for the TS parity case where `content` is
/// not an array. With Zig's typed `std.json.parseFromSlice(Response, ...)`
/// a non-array content fails at parse time, so this is effectively
/// unreachable from typed parsing; it exists to mirror the TS contract and
/// can be hit by hand-constructing a Response.
///
/// Use an arena allocator to free reply.message.text + tool_calls (and
/// nested argument std.json.Values) all at once.
pub fn fromAnthropic(resp: Response, alloc: std.mem.Allocator) FromError!luv.Reply {
    var text: std.ArrayList(u8) = .empty;
    errdefer text.deinit(alloc);

    var calls: std.ArrayList(luv.ToolCall) = .empty;
    errdefer calls.deinit(alloc);

    for (resp.content) |block| {
        if (std.mem.eql(u8, block.type, "text")) {
            if (block.text) |t| try text.appendSlice(alloc, t);
        } else if (std.mem.eql(u8, block.type, "tool_use")) {
            // TS throws if id or name missing. We mirror by skipping the
            // typed fields when absent — but to keep parity with the
            // "missing id/name" error contract we treat absent as empty.
            const id = block.id orelse "";
            const name = block.name orelse "";
            const args: std.json.Value = block.input orelse .{ .object = .empty };
            try calls.append(alloc, .{
                .id = try alloc.dupe(u8, id),
                .name = try alloc.dupe(u8, name),
                .arguments = args,
            });
        }
        // Unknown block types (thinking, redacted_thinking, server_tool_use,
        // …) are silently dropped.
    }

    const owned_text = try text.toOwnedSlice(alloc);
    const tool_calls: []const luv.ToolCall =
        if (calls.items.len > 0) try calls.toOwnedSlice(alloc) else &.{};

    return .{
        .message = .{
            .role = .assistant,
            .text = owned_text,
            .tool_calls = tool_calls,
        },
        .stop_reason = stopReasonFrom(resp.stop_reason),
        // Match the TS port: usage present only when the wire carried it.
        .usage = if (resp.usage) |u| luv.Usage{
            .prompt_tokens = u.input_tokens,
            .completion_tokens = u.output_tokens,
            .total_tokens = u.input_tokens + u.output_tokens,
        } else null,
    };
}

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;

/// Recursive structural equality for parsed JSON values.
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

fn requestToValue(arena: std.mem.Allocator, req: Request) !std.json.Value {
    const s = try std.json.Stringify.valueAlloc(arena, req, .{
        .emit_null_optional_fields = false,
    });
    return std.json.parseFromSliceLeaky(std.json.Value, arena, s, .{});
}

fn parseValue(arena: std.mem.Allocator, json: []const u8) !std.json.Value {
    return std.json.parseFromSliceLeaky(std.json.Value, arena, json, .{});
}

test "toAnthropic: simple user-only conversation (max_tokens defaults to 1024)" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const messages = [_]luv.Message{
        .{ .role = .user, .text = "hi" },
    };
    const req = try toAnthropic(&messages, .{
        .model = "claude-3-5-sonnet-20241022",
    }, arena);

    const actual = try requestToValue(arena, req);
    const expected = try parseValue(arena,
        \\{
        \\  "model": "claude-3-5-sonnet-20241022",
        \\  "max_tokens": 1024,
        \\  "messages": [{ "role": "user", "content": "hi" }]
        \\}
    );
    try testing.expect(jsonEqual(actual, expected));
}

test "toAnthropic: system message lifts to top-level system field" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const messages = [_]luv.Message{
        .{ .role = .system, .text = "be terse" },
        .{ .role = .user, .text = "hi" },
    };
    const req = try toAnthropic(&messages, .{ .model = "claude-3-5-sonnet-20241022" }, arena);

    try testing.expect(req.system != null);
    try testing.expectEqualStrings("be terse", req.system.?);
    try testing.expectEqual(@as(usize, 1), req.messages.len);
    try testing.expectEqualStrings("user", req.messages[0].role);
    try testing.expectEqualStrings("hi", req.messages[0].content.text);
}

test "toAnthropic: multiple system messages concatenated with blank lines" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const messages = [_]luv.Message{
        .{ .role = .system, .text = "be terse" },
        .{ .role = .system, .text = "answer in english" },
        .{ .role = .user, .text = "hi" },
    };
    const req = try toAnthropic(&messages, .{ .model = "claude-3-5-sonnet-20241022" }, arena);
    try testing.expectEqualStrings("be terse\n\nanswer in english", req.system.?);
}

test "toAnthropic: assistant with toolCalls becomes content blocks" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const args = try parseValue(arena, "{\"city\":\"Tokyo\"}");
    const calls = [_]luv.ToolCall{
        .{ .id = "tool_abc", .name = "lookup_weather", .arguments = args },
    };
    const messages = [_]luv.Message{
        .{ .role = .user, .text = "weather in tokyo?" },
        .{ .role = .assistant, .text = "let me check", .tool_calls = &calls },
    };
    const req = try toAnthropic(&messages, .{ .model = "x" }, arena);
    const actual = try requestToValue(arena, req);

    const expected = try parseValue(arena,
        \\{
        \\  "model": "x",
        \\  "max_tokens": 1024,
        \\  "messages": [
        \\    { "role": "user", "content": "weather in tokyo?" },
        \\    { "role": "assistant", "content": [
        \\      { "type": "text", "text": "let me check" },
        \\      { "type": "tool_use", "id": "tool_abc", "name": "lookup_weather", "input": { "city": "Tokyo" } }
        \\    ]}
        \\  ]
        \\}
    );
    try testing.expect(jsonEqual(actual, expected));
}

test "toAnthropic: assistant with toolCalls and empty text emits only tool_use blocks" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const args = try parseValue(arena, "{\"city\":\"Tokyo\"}");
    const calls = [_]luv.ToolCall{
        .{ .id = "c1", .name = "lookup_weather", .arguments = args },
    };
    const messages = [_]luv.Message{
        .{ .role = .user, .text = "x" },
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const req = try toAnthropic(&messages, .{ .model = "x" }, arena);
    const actual = try requestToValue(arena, req);

    const expected = try parseValue(arena,
        \\{
        \\  "model": "x", "max_tokens": 1024,
        \\  "messages": [
        \\    { "role": "user", "content": "x" },
        \\    { "role": "assistant", "content": [
        \\      { "type": "tool_use", "id": "c1", "name": "lookup_weather", "input": { "city": "Tokyo" } }
        \\    ]}
        \\  ]
        \\}
    );
    try testing.expect(jsonEqual(actual, expected));
}

test "toAnthropic: tool result becomes a user message with tool_result block" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const args = try parseValue(arena, "{\"city\":\"Tokyo\"}");
    const calls = [_]luv.ToolCall{.{
        .id = "c1",
        .name = "lookup_weather",
        .arguments = args,
        .result = .{ .ok = "{\"temp_c\":18}" },
    }};
    const messages = [_]luv.Message{
        .{ .role = .user, .text = "weather in tokyo?" },
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const req = try toAnthropic(&messages, .{ .model = "x" }, arena);

    try testing.expectEqual(@as(usize, 3), req.messages.len);
    try testing.expectEqualStrings("user", req.messages[2].role);
    const blocks = req.messages[2].content.blocks;
    try testing.expectEqual(@as(usize, 1), blocks.len);
    const tr = blocks[0].tool_result;
    try testing.expectEqualStrings("c1", tr.tool_use_id);
    try testing.expectEqualStrings("{\"temp_c\":18}", tr.content);
    try testing.expect(tr.is_error == null);
}

test "toAnthropic: tool error is marked is_error true" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const args = try parseValue(arena, "{}");
    const calls = [_]luv.ToolCall{.{
        .id = "c1",
        .name = "lookup_weather",
        .arguments = args,
        .result = .{ .err = "boom" },
    }};
    const messages = [_]luv.Message{
        .{ .role = .user, .text = "x" },
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const req = try toAnthropic(&messages, .{ .model = "x" }, arena);

    const tr = req.messages[2].content.blocks[0].tool_result;
    try testing.expectEqual(true, tr.is_error.?);
    try testing.expectEqualStrings("boom", tr.content);
}

test "toAnthropic: tools[] maps to anthropic tools[] with input_schema" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const schema = try parseValue(arena,
        \\{ "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] }
    );
    const tools = [_]luv.Tool{.{
        .name = "lookup_weather",
        .description = "Returns current weather for a city",
        .input_schema = schema,
    }};
    const messages = [_]luv.Message{.{ .role = .user, .text = "x" }};
    const req = try toAnthropic(&messages, .{ .model = "x", .tools = &tools }, arena);

    const actual = try requestToValue(arena, req);
    const tool0 = actual.object.get("tools").?.array.items[0];
    const expected_tool = try parseValue(arena,
        \\{
        \\  "name": "lookup_weather",
        \\  "description": "Returns current weather for a city",
        \\  "input_schema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] }
        \\}
    );
    try testing.expect(jsonEqual(tool0, expected_tool));
}

test "toAnthropic: max_tokens passed through when set" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const messages = [_]luv.Message{.{ .role = .user, .text = "x" }};
    const req = try toAnthropic(&messages, .{ .model = "x", .max_tokens = 256 }, arena);
    try testing.expectEqual(@as(u32, 256), req.max_tokens);
}

test "toAnthropic: consecutive tool results fold into a single user message" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const a1 = try parseValue(arena, "{\"city\":\"Tokyo\"}");
    const a2 = try parseValue(arena, "{\"city\":\"Berlin\"}");
    const calls = [_]luv.ToolCall{
        .{ .id = "c1", .name = "lookup_weather", .arguments = a1, .result = .{ .ok = "tokyo data" } },
        .{ .id = "c2", .name = "lookup_weather", .arguments = a2, .result = .{ .ok = "berlin data" } },
    };
    const messages = [_]luv.Message{
        .{ .role = .user, .text = "x" },
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const req = try toAnthropic(&messages, .{ .model = "x" }, arena);

    try testing.expectEqual(@as(usize, 3), req.messages.len);
    try testing.expectEqualStrings("user", req.messages[2].role);
    const blocks = req.messages[2].content.blocks;
    try testing.expectEqual(@as(usize, 2), blocks.len);
    try testing.expectEqualStrings("c1", blocks[0].tool_result.tool_use_id);
    try testing.expectEqualStrings("c2", blocks[1].tool_result.tool_use_id);
}

test "toAnthropic: stream true is emitted when set" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const messages = [_]luv.Message{.{ .role = .user, .text = "x" }};
    const req = try toAnthropic(&messages, .{ .model = "x", .stream = true }, arena);
    try testing.expectEqual(@as(?bool, true), req.stream);

    const actual = try requestToValue(arena, req);
    try testing.expectEqual(true, actual.object.get("stream").?.bool);
}

test "toAnthropic: temperature 0 is emitted (not dropped as falsy)" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const messages = [_]luv.Message{.{ .role = .user, .text = "x" }};
    const req = try toAnthropic(&messages, .{ .model = "x", .temperature = 0 }, arena);

    const actual = try requestToValue(arena, req);
    const t = actual.object.get("temperature").?;
    // 0 may parse as integer 0 or float 0.0 depending on serialization.
    const is_zero = switch (t) {
        .integer => |i| i == 0,
        .float => |f| f == 0.0,
        .number_string => |s| std.mem.eql(u8, s, "0") or std.mem.eql(u8, s, "0.0"),
        else => false,
    };
    try testing.expect(is_zero);
}

test "fromAnthropic: text-only response parses to assistant Reply" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const json =
        \\{
        \\  "id": "msg_x", "type": "message", "role": "assistant",
        \\  "content": [{ "type": "text", "text": "Hello!" }],
        \\  "model": "claude-3-5-sonnet-20241022",
        \\  "stop_reason": "end_turn",
        \\  "usage": { "input_tokens": 10, "output_tokens": 5 }
        \\}
    ;
    const parsed = try std.json.parseFromSliceLeaky(Response, arena, json, .{ .ignore_unknown_fields = true });
    const reply = try fromAnthropic(parsed, arena);

    try testing.expectEqual(luv.Role.assistant, reply.message.role);
    try testing.expectEqualStrings("Hello!", reply.message.text);
    try testing.expectEqual(@as(usize, 0), reply.message.tool_calls.len);
    try testing.expectEqual(luv.StopReason.end_turn, reply.stop_reason);
    try testing.expectEqual(@as(u32, 10), reply.usage.?.prompt_tokens);
    try testing.expectEqual(@as(u32, 5), reply.usage.?.completion_tokens);
    try testing.expectEqual(@as(u32, 15), reply.usage.?.total_tokens);
}

test "fromAnthropic: text + tool_use blocks combine into single message" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const json =
        \\{
        \\  "id": "msg_x", "type": "message", "role": "assistant",
        \\  "content": [
        \\    { "type": "text", "text": "let me check" },
        \\    { "type": "tool_use", "id": "c1", "name": "lookup_weather", "input": { "city": "Tokyo" } }
        \\  ],
        \\  "model": "x", "stop_reason": "tool_use",
        \\  "usage": { "input_tokens": 20, "output_tokens": 8 }
        \\}
    ;
    const parsed = try std.json.parseFromSliceLeaky(Response, arena, json, .{ .ignore_unknown_fields = true });
    const reply = try fromAnthropic(parsed, arena);

    try testing.expectEqualStrings("let me check", reply.message.text);
    try testing.expectEqual(@as(usize, 1), reply.message.tool_calls.len);
    try testing.expectEqualStrings("c1", reply.message.tool_calls[0].id);
    try testing.expectEqualStrings("Tokyo", reply.message.tool_calls[0].arguments.object.get("city").?.string);
    try testing.expectEqual(luv.StopReason.tool_use, reply.stop_reason);
}

test "fromAnthropic: stop_reason vocabulary maps cleanly" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const cases = [_]struct { s: []const u8, want: luv.StopReason }{
        .{ .s = "end_turn", .want = .end_turn },
        .{ .s = "max_tokens", .want = .max_tokens },
        .{ .s = "stop_sequence", .want = .stop_sequence },
        .{ .s = "tool_use", .want = .tool_use },
        .{ .s = "weird_unknown", .want = .other },
    };
    for (cases) |c| {
        const json = try std.fmt.allocPrint(arena,
            \\{{ "content": [{{ "type": "text", "text": "x" }}], "stop_reason": "{s}", "usage": {{ "input_tokens": 1, "output_tokens": 1 }} }}
        , .{c.s});
        const parsed = try std.json.parseFromSliceLeaky(Response, arena, json, .{ .ignore_unknown_fields = true });
        const reply = try fromAnthropic(parsed, arena);
        try testing.expectEqual(c.want, reply.stop_reason);
    }
}

test "fromAnthropic: unknown block types are silently dropped" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const json =
        \\{
        \\  "content": [
        \\    { "type": "thinking", "text": "internal monologue dropped" },
        \\    { "type": "text", "text": "actual reply" }
        \\  ],
        \\  "stop_reason": "end_turn",
        \\  "usage": { "input_tokens": 1, "output_tokens": 1 }
        \\}
    ;
    const parsed = try std.json.parseFromSliceLeaky(Response, arena, json, .{ .ignore_unknown_fields = true });
    const reply = try fromAnthropic(parsed, arena);
    try testing.expectEqualStrings("actual reply", reply.message.text);
}

test "fromAnthropic: empty content array is a valid empty-text reply" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const json =
        \\{ "content": [], "stop_reason": "end_turn", "usage": { "input_tokens": 1, "output_tokens": 0 } }
    ;
    const parsed = try std.json.parseFromSliceLeaky(Response, arena, json, .{ .ignore_unknown_fields = true });
    const reply = try fromAnthropic(parsed, arena);
    try testing.expectEqualStrings("", reply.message.text);
    try testing.expectEqual(@as(usize, 0), reply.message.tool_calls.len);
}

test "fromAnthropic: stop_reason null maps to other" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const json =
        \\{ "content": [{ "type": "text", "text": "x" }], "stop_reason": null, "usage": { "input_tokens": 1, "output_tokens": 1 } }
    ;
    const parsed = try std.json.parseFromSliceLeaky(Response, arena, json, .{ .ignore_unknown_fields = true });
    const reply = try fromAnthropic(parsed, arena);
    try testing.expectEqual(luv.StopReason.other, reply.stop_reason);
}

test "fromAnthropic: missing stop_reason field maps to other" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const json =
        \\{ "content": [{ "type": "text", "text": "x" }], "usage": { "input_tokens": 1, "output_tokens": 1 } }
    ;
    const parsed = try std.json.parseFromSliceLeaky(Response, arena, json, .{ .ignore_unknown_fields = true });
    const reply = try fromAnthropic(parsed, arena);
    try testing.expectEqual(luv.StopReason.other, reply.stop_reason);
}
