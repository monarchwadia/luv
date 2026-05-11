//! Pure functional utilities over the canonical luv Conversation for
//! inspecting and resolving tool calls. The conversation array is the only
//! state — there is no registry. A tool call is "pending" iff its
//! `.result` is null; resolving it produces a new conversation slice where
//! that call carries its result.
//!
//! Same semantics as the eventual lib/js/src/tool_calls.ts mirror.

const std = @import("std");
const luv = @import("luv.zig");

/// Collect every tool call across all assistant messages whose `result`
/// is still null. The returned slice is allocator-owned; caller frees.
///
/// Filtering is intentionally not built-in — apply it on the result:
///   `for (calls) |c| if (predicate(c)) ...`
pub fn pendingToolCalls(
    conv: luv.Conversation,
    alloc: std.mem.Allocator,
) ![]luv.ToolCall {
    var out: std.ArrayList(luv.ToolCall) = .empty;
    errdefer out.deinit(alloc);
    for (conv) |m| {
        if (m.role != .assistant) continue;
        for (m.tool_calls) |c| {
            if (c.result != null) continue;
            try out.append(alloc, c);
        }
    }
    return out.toOwnedSlice(alloc);
}

/// Return a fresh conversation slice where the tool call matching
/// `call_id` carries the given `result`. If no call matches, returns a
/// shallow copy of the input. Existing results are overwritten.
///
/// The returned slice and any rebuilt `tool_calls` sub-slices are
/// allocator-owned; caller frees both.
pub fn respondToToolCall(
    conv: luv.Conversation,
    call_id: []const u8,
    result: luv.ToolResult,
    alloc: std.mem.Allocator,
) ![]luv.Message {
    const out = try alloc.alloc(luv.Message, conv.len);
    errdefer alloc.free(out);

    for (conv, 0..) |m, i| {
        out[i] = m; // struct copy — borrows the original tool_calls slice by default
        if (m.role != .assistant or m.tool_calls.len == 0) continue;

        var has_match = false;
        for (m.tool_calls) |c| {
            if (std.mem.eql(u8, c.id, call_id)) {
                has_match = true;
                break;
            }
        }
        if (!has_match) continue;

        const new_calls = try alloc.alloc(luv.ToolCall, m.tool_calls.len);
        for (m.tool_calls, 0..) |c, j| {
            new_calls[j] = c;
            if (std.mem.eql(u8, c.id, call_id)) new_calls[j].result = result;
        }
        out[i].tool_calls = new_calls;
    }
    return out;
}

// ===========================================================================
// Tests

const testing = std.testing;

fn parseArgs(arena: std.mem.Allocator, src: []const u8) !std.json.Value {
    return std.json.parseFromSliceLeaky(std.json.Value, arena, src, .{});
}

// ---------- pendingToolCalls ----------

test "pendingToolCalls: empty conversation → empty" {
    const empty: luv.Conversation = &.{};
    const out = try pendingToolCalls(empty, testing.allocator);
    defer testing.allocator.free(out);
    try testing.expectEqual(@as(usize, 0), out.len);
}

test "pendingToolCalls: no assistant messages → empty" {
    const conv = [_]luv.Message{
        .{ .role = .system, .text = "be terse" },
        .{ .role = .user, .text = "yo" },
    };
    const out = try pendingToolCalls(&conv, testing.allocator);
    defer testing.allocator.free(out);
    try testing.expectEqual(@as(usize, 0), out.len);
}

test "pendingToolCalls: assistant message with no tool_calls → empty" {
    const conv = [_]luv.Message{
        .{ .role = .assistant, .text = "ok" },
    };
    const out = try pendingToolCalls(&conv, testing.allocator);
    defer testing.allocator.free(out);
    try testing.expectEqual(@as(usize, 0), out.len);
}

test "pendingToolCalls: returns calls with result=null" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const args = try parseArgs(arena, "{\"x\":1}");

    const calls = [_]luv.ToolCall{
        .{ .id = "a", .name = "f", .arguments = args },
        .{ .id = "b", .name = "g", .arguments = args },
    };
    const conv = [_]luv.Message{
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const out = try pendingToolCalls(&conv, testing.allocator);
    defer testing.allocator.free(out);

    try testing.expectEqual(@as(usize, 2), out.len);
    try testing.expectEqualStrings("a", out[0].id);
    try testing.expectEqualStrings("b", out[1].id);
}

test "pendingToolCalls: skips calls that already have a result" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const args = try parseArgs(arena, "{}");

    const calls = [_]luv.ToolCall{
        .{ .id = "a", .name = "f", .arguments = args, .result = .{ .ok = "done" } },
        .{ .id = "b", .name = "g", .arguments = args },
    };
    const conv = [_]luv.Message{
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const out = try pendingToolCalls(&conv, testing.allocator);
    defer testing.allocator.free(out);

    try testing.expectEqual(@as(usize, 1), out.len);
    try testing.expectEqualStrings("b", out[0].id);
}

test "pendingToolCalls: aggregates across multiple assistant turns" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const args = try parseArgs(arena, "{}");

    const calls_turn_one = [_]luv.ToolCall{
        .{ .id = "a", .name = "f", .arguments = args },
        .{ .id = "b", .name = "g", .arguments = args, .result = .{ .ok = "x" } },
    };
    const calls_turn_two = [_]luv.ToolCall{
        .{ .id = "c", .name = "h", .arguments = args },
    };
    const conv = [_]luv.Message{
        .{ .role = .user, .text = "go" },
        .{ .role = .assistant, .text = "", .tool_calls = &calls_turn_one },
        .{ .role = .user, .text = "more" },
        .{ .role = .assistant, .text = "", .tool_calls = &calls_turn_two },
    };
    const out = try pendingToolCalls(&conv, testing.allocator);
    defer testing.allocator.free(out);

    try testing.expectEqual(@as(usize, 2), out.len);
    try testing.expectEqualStrings("a", out[0].id);
    try testing.expectEqualStrings("c", out[1].id);
}

// ---------- respondToToolCall ----------

test "respondToToolCall: sets result on the matching tool call" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const args = try parseArgs(arena, "{}");

    const calls = [_]luv.ToolCall{.{ .id = "a", .name = "f", .arguments = args }};
    const conv = [_]luv.Message{
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const out = try respondToToolCall(&conv, "a", .{ .ok = "42" }, testing.allocator);
    defer testing.allocator.free(out);
    defer testing.allocator.free(out[0].tool_calls);

    try testing.expectEqual(@as(usize, 1), out.len);
    try testing.expectEqual(@as(usize, 1), out[0].tool_calls.len);
    try testing.expectEqualStrings("a", out[0].tool_calls[0].id);
    try testing.expect(out[0].tool_calls[0].result != null);
    switch (out[0].tool_calls[0].result.?) {
        .ok => |s| try testing.expectEqualStrings("42", s),
        .err => try testing.expect(false),
    }
}

test "respondToToolCall: does not mutate the input conversation" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const args = try parseArgs(arena, "{}");

    const calls = [_]luv.ToolCall{.{ .id = "a", .name = "f", .arguments = args }};
    const conv = [_]luv.Message{
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const out = try respondToToolCall(&conv, "a", .{ .ok = "ok" }, testing.allocator);
    defer testing.allocator.free(out);
    defer testing.allocator.free(out[0].tool_calls);

    // Original input still has no result.
    try testing.expectEqual(@as(?luv.ToolResult, null), conv[0].tool_calls[0].result);
}

test "respondToToolCall: preserves siblings on the same assistant message" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const args = try parseArgs(arena, "{}");

    const calls = [_]luv.ToolCall{
        .{ .id = "a", .name = "f", .arguments = args },
        .{ .id = "b", .name = "g", .arguments = args },
    };
    const conv = [_]luv.Message{
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const out = try respondToToolCall(&conv, "b", .{ .ok = "B" }, testing.allocator);
    defer testing.allocator.free(out);
    defer testing.allocator.free(out[0].tool_calls);

    try testing.expectEqual(@as(usize, 2), out[0].tool_calls.len);
    // a stays unresolved
    try testing.expectEqual(@as(?luv.ToolResult, null), out[0].tool_calls[0].result);
    // b has result
    try testing.expect(out[0].tool_calls[1].result != null);
    switch (out[0].tool_calls[1].result.?) {
        .ok => |s| try testing.expectEqualStrings("B", s),
        .err => try testing.expect(false),
    }
}

test "respondToToolCall: only touches the assistant message that owns the call" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const args = try parseArgs(arena, "{}");

    const calls_one = [_]luv.ToolCall{.{ .id = "a", .name = "f", .arguments = args }};
    const calls_two = [_]luv.ToolCall{.{ .id = "b", .name = "g", .arguments = args }};
    const conv = [_]luv.Message{
        .{ .role = .user, .text = "first" },
        .{ .role = .assistant, .text = "", .tool_calls = &calls_one },
        .{ .role = .user, .text = "second" },
        .{ .role = .assistant, .text = "", .tool_calls = &calls_two },
    };
    const out = try respondToToolCall(&conv, "b", .{ .err = "nope" }, testing.allocator);
    defer testing.allocator.free(out);
    // Only the last assistant message has freshly-allocated tool_calls.
    defer testing.allocator.free(out[3].tool_calls);

    try testing.expectEqual(@as(usize, 4), out.len);
    try testing.expectEqual(@as(?luv.ToolResult, null), out[1].tool_calls[0].result);
    try testing.expect(out[3].tool_calls[0].result != null);
    switch (out[3].tool_calls[0].result.?) {
        .ok => try testing.expect(false),
        .err => |s| try testing.expectEqualStrings("nope", s),
    }
}

test "respondToToolCall: unknown call_id returns shallow copy unchanged" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const args = try parseArgs(arena, "{}");

    const calls = [_]luv.ToolCall{.{ .id = "a", .name = "f", .arguments = args }};
    const conv = [_]luv.Message{
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const out = try respondToToolCall(&conv, "nope", .{ .ok = "x" }, testing.allocator);
    defer testing.allocator.free(out);
    // No matching call — tool_calls slice was NOT reallocated; do not free it.

    try testing.expectEqual(@as(usize, 1), out.len);
    try testing.expectEqual(@as(usize, 1), out[0].tool_calls.len);
    try testing.expectEqual(@as(?luv.ToolResult, null), out[0].tool_calls[0].result);
}

test "respondToToolCall: overwriting an existing result is allowed" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const args = try parseArgs(arena, "{}");

    const calls = [_]luv.ToolCall{
        .{ .id = "a", .name = "f", .arguments = args, .result = .{ .ok = "first" } },
    };
    const conv = [_]luv.Message{
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const out = try respondToToolCall(&conv, "a", .{ .err = "second" }, testing.allocator);
    defer testing.allocator.free(out);
    defer testing.allocator.free(out[0].tool_calls);

    switch (out[0].tool_calls[0].result.?) {
        .ok => try testing.expect(false),
        .err => |s| try testing.expectEqualStrings("second", s),
    }
}
