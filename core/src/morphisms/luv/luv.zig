//! Canonical luv types: pure data, no methods, no I/O.
//!
//! These are the largest common subset of all provider chat APIs — a forgetful
//! quotient. Provider morphisms map between this shape and provider-specific
//! wire JSON. Ownership of any string fields is the caller's responsibility.

const std = @import("std");

pub const Role = enum { system, user, assistant, tool };

pub const StopReason = enum {
    end_turn,
    max_tokens,
    content_filter,
    stop_sequence,
    tool_use,
    other,
};

/// Tagged union — caller checks `.ok` or `.err` to discriminate.
/// `.ok` content is the tool's output (often JSON-stringified).
/// `.err` content is a human-readable error description.
pub const ToolResult = union(enum) {
    ok: []const u8,
    err: []const u8,
};

/// Provider says "please call this tool with these arguments".
/// `arguments` is the parsed JSON the model emitted; lifetime tied to the
/// parser arena that produced it.
pub const ToolCall = struct {
    id: []const u8,
    name: []const u8,
    arguments: std.json.Value,
};

/// Tool definition: what an agent can call. Handler is wired by the agent
/// layer (not part of the canonical type — the canonical part is the schema
/// and identity).
pub const Tool = struct {
    name: []const u8,
    description: []const u8,
    /// JSON Schema describing the input shape. Provider morphisms pass it
    /// through to the wire request as-is.
    input_schema: std.json.Value,
};

/// Conversation message.
///
/// Flat shape with optional fields rather than a tagged union, so existing
/// code that just reads `.role` and `.text` keeps working. The variants:
///   - system / user:    text set, others empty/null
///   - assistant:        text set; tool_calls non-empty when the model is
///                       requesting tool execution
///   - tool:             call_id + result set; text empty
pub const Message = struct {
    role: Role,
    text: []const u8 = "",
    tool_calls: []const ToolCall = &.{},
    call_id: ?[]const u8 = null,
    result: ?ToolResult = null,
};

/// A conversation is just a slice of messages — pure data.
pub const Conversation = []const Message;

pub const Usage = struct {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
};

pub const Reply = struct {
    message: Message,
    stop_reason: StopReason,
    /// Token counts from the provider, when reported.
    usage: ?Usage = null,
};

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;

test "Message is plain data" {
    const m: Message = .{ .role = .user, .text = "hi" };
    try testing.expectEqual(Role.user, m.role);
    try testing.expectEqualStrings("hi", m.text);
}

test "Conversation is just a slice of Message" {
    const messages = [_]Message{
        .{ .role = .system, .text = "be terse" },
        .{ .role = .user, .text = "hello" },
        .{ .role = .assistant, .text = "hi" },
    };
    const conv: Conversation = &messages;
    try testing.expectEqual(@as(usize, 3), conv.len);
    try testing.expectEqual(Role.system, conv[0].role);
    try testing.expectEqualStrings("be terse", conv[0].text);
    try testing.expectEqual(Role.assistant, conv[2].role);
}

test "Reply pairs an assistant message with a stop reason" {
    const r: Reply = .{
        .message = .{ .role = .assistant, .text = "ok" },
        .stop_reason = .end_turn,
    };
    try testing.expectEqual(Role.assistant, r.message.role);
    try testing.expectEqual(StopReason.end_turn, r.stop_reason);
}

test "ToolResult.ok carries content" {
    const r: ToolResult = .{ .ok = "42" };
    switch (r) {
        .ok => |content| try testing.expectEqualStrings("42", content),
        .err => try testing.expect(false),
    }
}

test "ToolResult.err carries error message" {
    const r: ToolResult = .{ .err = "tool not found" };
    switch (r) {
        .ok => try testing.expect(false),
        .err => |msg| try testing.expectEqualStrings("tool not found", msg),
    }
}

test "ToolCall holds id, name, and parsed arguments" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const parsed = try std.json.parseFromSliceLeaky(
        std.json.Value,
        arena.allocator(),
        "{\"city\":\"Tokyo\"}",
        .{},
    );

    const call: ToolCall = .{
        .id = "call_abc123",
        .name = "lookup_weather",
        .arguments = parsed,
    };
    try testing.expectEqualStrings("call_abc123", call.id);
    try testing.expectEqualStrings("lookup_weather", call.name);
    try testing.expectEqual(std.meta.Tag(std.json.Value).object, std.meta.activeTag(call.arguments));
    try testing.expectEqualStrings("Tokyo", call.arguments.object.get("city").?.string);
}

test "Tool holds name, description, and a schema Value" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const schema = try std.json.parseFromSliceLeaky(
        std.json.Value,
        arena.allocator(),
        "{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}}}",
        .{},
    );

    const t: Tool = .{
        .name = "lookup_weather",
        .description = "Returns current weather for a city",
        .input_schema = schema,
    };
    try testing.expectEqualStrings("lookup_weather", t.name);
    try testing.expectEqualStrings("Returns current weather for a city", t.description);
    try testing.expectEqual(std.meta.Tag(std.json.Value).object, std.meta.activeTag(t.input_schema));
}

test "Assistant Message can carry tool_calls" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const args = try std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), "{}", .{});

    const calls = [_]ToolCall{
        .{ .id = "c1", .name = "lookup_weather", .arguments = args },
    };
    const m: Message = .{
        .role = .assistant,
        .text = "let me check the weather",
        .tool_calls = &calls,
    };
    try testing.expectEqual(Role.assistant, m.role);
    try testing.expectEqualStrings("let me check the weather", m.text);
    try testing.expectEqual(@as(usize, 1), m.tool_calls.len);
    try testing.expectEqualStrings("c1", m.tool_calls[0].id);
}

test "Tool Message carries call_id and result, no text" {
    const m: Message = .{
        .role = .tool,
        .call_id = "c1",
        .result = .{ .ok = "{\"temp_c\":18}" },
    };
    try testing.expectEqual(Role.tool, m.role);
    try testing.expectEqualStrings("c1", m.call_id.?);
    try testing.expectEqualStrings("", m.text);
    switch (m.result.?) {
        .ok => |content| try testing.expectEqualStrings("{\"temp_c\":18}", content),
        .err => try testing.expect(false),
    }
}

test "Conversation can mix all message variants" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const args = try std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), "{\"city\":\"Tokyo\"}", .{});
    const calls = [_]ToolCall{.{ .id = "c1", .name = "lookup_weather", .arguments = args }};

    const conv = [_]Message{
        .{ .role = .system, .text = "be terse" },
        .{ .role = .user, .text = "weather in Tokyo?" },
        .{ .role = .assistant, .text = "checking…", .tool_calls = &calls },
        .{ .role = .tool, .call_id = "c1", .result = .{ .ok = "{\"temp_c\":18}" } },
        .{ .role = .assistant, .text = "It's 18°C in Tokyo." },
    };

    try testing.expectEqual(@as(usize, 5), conv.len);
    try testing.expectEqual(Role.system, conv[0].role);
    try testing.expectEqual(Role.assistant, conv[2].role);
    try testing.expectEqual(@as(usize, 1), conv[2].tool_calls.len);
    try testing.expectEqual(Role.tool, conv[3].role);
    try testing.expectEqualStrings("c1", conv[3].call_id.?);
}
