//! runAgent: the default agent loop. Pure function on the conversation —
//! never owns state, never returns anything other than a luv-shaped result.
//!
//! Same semantics as lib/js/src/agent.ts; same fixture-validated behavior.

const std = @import("std");
const luv = @import("../morphisms/luv/luv.zig");

pub const AgentFinishReason = enum {
    end_turn,
    max_iterations,
    aborted,
    @"error",
};

pub const ProviderSendOptions = struct {
    model: []const u8,
    conversation: luv.Conversation,
    tools: []const luv.Tool = &.{},
    max_tokens: ?u32 = null,
    temperature: ?f32 = null,
};

pub const Provider = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        send: *const fn (ptr: *anyopaque, opts: ProviderSendOptions, alloc: std.mem.Allocator) anyerror!luv.Reply,
    };

    pub fn send(self: Provider, opts: ProviderSendOptions, alloc: std.mem.Allocator) anyerror!luv.Reply {
        return self.vtable.send(self.ptr, opts, alloc);
    }
};

pub const ToolHandler = *const fn (
    args: std.json.Value,
    handler_ctx: ?*anyopaque,
    alloc: std.mem.Allocator,
) anyerror!luv.ToolResult;

/// A luv.Tool plus the handler+context the agent loop will call when the
/// model requests this tool. Inline rather than wrapping luv.Tool so the test
/// surface stays flat.
pub const AgentTool = struct {
    name: []const u8,
    description: []const u8,
    input_schema: std.json.Value,
    handler: ToolHandler,
    handler_ctx: ?*anyopaque = null,

    /// Project the wire-side luv.Tool view (drops handler/ctx).
    pub fn toLuv(self: AgentTool) luv.Tool {
        return .{
            .name = self.name,
            .description = self.description,
            .input_schema = self.input_schema,
        };
    }
};

pub const AgentOptions = struct {
    provider: Provider,
    model: []const u8,
    conversation: luv.Conversation,
    tools: []const AgentTool = &.{},
    max_iterations: u32 = 10,
    max_tokens: ?u32 = null,
    temperature: ?f32 = null,
    aborted: ?*const bool = null,
    /// Optional lifecycle hooks. Each gets the global hook_ctx pointer.
    on_turn_start: ?*const fn (ctx: ?*anyopaque, iteration: u32) void = null,
    on_tool_call: ?*const fn (ctx: ?*anyopaque, call: luv.ToolCall) void = null,
    on_tool_result: ?*const fn (ctx: ?*anyopaque, call: luv.ToolCall, result: luv.ToolResult) void = null,
    on_finish: ?*const fn (ctx: ?*anyopaque, reason: AgentFinishReason) void = null,
    hook_ctx: ?*anyopaque = null,
};

pub const AgentResult = struct {
    conversation: []luv.Message,
    reason: AgentFinishReason,
    iterations: u32,
};

/// Run the agent loop. The returned AgentResult.conversation is allocator-owned;
/// caller frees with the same allocator (or use an arena and drop it).
pub fn runAgent(opts: AgentOptions, alloc: std.mem.Allocator) !AgentResult {
    var conversation: std.ArrayList(luv.Message) = .empty;
    errdefer conversation.deinit(alloc);
    try conversation.appendSlice(alloc, opts.conversation);

    // Project the AgentTool[] to the luv.Tool[] the provider sees on the wire.
    const wire_tools = try alloc.alloc(luv.Tool, opts.tools.len);
    defer alloc.free(wire_tools);
    for (opts.tools, 0..) |t, i| wire_tools[i] = t.toLuv();

    var iterations: u32 = 0;

    while (true) {
        iterations += 1;

        if (isAborted(opts)) return finish(&conversation, alloc, .aborted, iterations, opts);
        if (iterations > opts.max_iterations) return finish(&conversation, alloc, .max_iterations, iterations, opts);

        if (opts.on_turn_start) |hook| hook(opts.hook_ctx, iterations);

        const reply = opts.provider.send(.{
            .model = opts.model,
            .conversation = conversation.items,
            .tools = wire_tools,
            .max_tokens = opts.max_tokens,
            .temperature = opts.temperature,
        }, alloc) catch return finish(&conversation, alloc, .@"error", iterations, opts);

        if (isAborted(opts)) return finish(&conversation, alloc, .aborted, iterations, opts);

        try conversation.append(alloc, reply.message);

        const reply_calls = if (reply.message.role == .assistant) reply.message.tool_calls else &.{};
        if (reply_calls.len == 0) return finish(&conversation, alloc, .end_turn, iterations, opts);

        // Take ownership of the just-appended message's tool_calls so we
        // can write resolved results back onto the calls themselves.
        const owned_calls = try alloc.alloc(luv.ToolCall, reply_calls.len);
        for (reply_calls, 0..) |c, i| owned_calls[i] = c;
        conversation.items[conversation.items.len - 1].tool_calls = owned_calls;

        for (owned_calls, 0..) |call, idx| {
            if (opts.on_tool_call) |hook| hook(opts.hook_ctx, call);
            const result = executeToolCall(opts.tools, call, alloc) catch |err| blk: {
                const msg = try std.fmt.allocPrint(alloc, "{s}", .{@errorName(err)});
                break :blk luv.ToolResult{ .err = msg };
            };
            if (opts.on_tool_result) |hook| hook(opts.hook_ctx, call, result);
            owned_calls[idx].result = result;
        }
    }
}

fn isAborted(opts: AgentOptions) bool {
    if (opts.aborted) |a| return a.*;
    return false;
}

fn finish(
    conversation: *std.ArrayList(luv.Message),
    alloc: std.mem.Allocator,
    reason: AgentFinishReason,
    iterations: u32,
    opts: AgentOptions,
) !AgentResult {
    if (opts.on_finish) |hook| hook(opts.hook_ctx, reason);
    const slice = try conversation.toOwnedSlice(alloc);
    return .{
        .conversation = slice,
        .reason = reason,
        .iterations = iterations,
    };
}

fn executeToolCall(
    tools: []const AgentTool,
    call: luv.ToolCall,
    alloc: std.mem.Allocator,
) !luv.ToolResult {
    for (tools) |t| {
        if (std.mem.eql(u8, t.name, call.name)) {
            return t.handler(call.arguments, t.handler_ctx, alloc);
        }
    }
    const msg = try std.fmt.allocPrint(alloc, "unknown tool: {s}", .{call.name});
    return luv.ToolResult{ .err = msg };
}

// ===========================================================================
// Tests — replay scenario fixtures, assert behavior matches.

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

/// Mock provider: returns canned replies in order, regardless of input.
const MockProvider = struct {
    replies: []const luv.Reply,
    cursor: usize = 0,

    fn provider(self: *MockProvider) Provider {
        return .{ .ptr = self, .vtable = &vtable };
    }

    fn sendImpl(ptr: *anyopaque, _: ProviderSendOptions, alloc: std.mem.Allocator) anyerror!luv.Reply {
        const self: *MockProvider = @ptrCast(@alignCast(ptr));
        if (self.cursor >= self.replies.len) return error.OutOfReplies;
        const reply = self.replies[self.cursor];
        self.cursor += 1;
        // Deep-copy strings so the test arena owns them and the loop's
        // conversation accumulator can append safely.
        return .{
            .message = .{
                .role = reply.message.role,
                .text = try alloc.dupe(u8, reply.message.text),
                .tool_calls = try dupToolCalls(reply.message.tool_calls, alloc),
            },
            .stop_reason = reply.stop_reason,
        };
    }

    const vtable: Provider.VTable = .{ .send = sendImpl };
};

fn dupToolCalls(calls: []const luv.ToolCall, alloc: std.mem.Allocator) ![]luv.ToolCall {
    if (calls.len == 0) return &.{};
    const out = try alloc.alloc(luv.ToolCall, calls.len);
    for (calls, 0..) |c, i| {
        out[i] = .{
            .id = try alloc.dupe(u8, c.id),
            .name = try alloc.dupe(u8, c.name),
            .arguments = c.arguments, // borrowed; caller arena owns
        };
    }
    return out;
}

/// Build a tool handler factory whose handler returns a fixed result by name.
const CannedToolHandlers = struct {
    map: std.StringHashMap(luv.ToolResult),

    fn make(self: *CannedToolHandlers) ToolHandler {
        _ = self;
        return canned_handler;
    }

    fn canned_handler(args: std.json.Value, ctx: ?*anyopaque, alloc: std.mem.Allocator) anyerror!luv.ToolResult {
        _ = args;
        const self: *CannedToolHandlers = @ptrCast(@alignCast(ctx.?));
        // The handler doesn't have access to the call name here; ctx must be
        // the per-tool result, not the whole map. We work around this by
        // making each tool's handler_ctx point at its own ToolResult cell.
        _ = alloc;
        _ = self;
        unreachable;
    }
};

/// Per-tool ctx: a single ToolResult to return verbatim.
fn fixedResultHandler(_: std.json.Value, ctx: ?*anyopaque, alloc: std.mem.Allocator) anyerror!luv.ToolResult {
    const result_ptr: *const luv.ToolResult = @ptrCast(@alignCast(ctx.?));
    // dup the ok/err string so result outlives any per-call arena
    return switch (result_ptr.*) {
        .ok => |s| luv.ToolResult{ .ok = try alloc.dupe(u8, s) },
        .err => |s| luv.ToolResult{ .err = try alloc.dupe(u8, s) },
    };
}

const ScenarioReplyParser = struct {
    fn parse(arena: std.mem.Allocator, value: std.json.Value) !luv.Reply {
        const obj = value.object;
        const msg_val = obj.get("message").?;
        const msg = msg_val.object;
        const role_str = msg.get("role").?.string;
        const role: luv.Role = if (std.mem.eql(u8, role_str, "assistant"))
            .assistant
        else if (std.mem.eql(u8, role_str, "user"))
            .user
        else if (std.mem.eql(u8, role_str, "system"))
            .system
        else
            return error.UnknownRole;
        const text = if (msg.get("text")) |t| t.string else "";

        var tool_calls: []const luv.ToolCall = &.{};
        if (msg.get("toolCalls")) |tc_val| {
            if (tc_val == .array) {
                const arr = tc_val.array.items;
                const out = try arena.alloc(luv.ToolCall, arr.len);
                for (arr, 0..) |c_val, i| {
                    const c = c_val.object;
                    out[i] = .{
                        .id = c.get("id").?.string,
                        .name = c.get("name").?.string,
                        .arguments = c.get("arguments").?,
                    };
                }
                tool_calls = out;
            }
        }

        const stop_str = obj.get("stopReason").?.string;
        const stop: luv.StopReason = if (std.mem.eql(u8, stop_str, "end_turn"))
            .end_turn
        else if (std.mem.eql(u8, stop_str, "max_tokens"))
            .max_tokens
        else if (std.mem.eql(u8, stop_str, "content_filter"))
            .content_filter
        else if (std.mem.eql(u8, stop_str, "stop_sequence"))
            .stop_sequence
        else if (std.mem.eql(u8, stop_str, "tool_use"))
            .tool_use
        else
            .other;

        return .{
            .message = .{ .role = role, .text = text, .tool_calls = tool_calls },
            .stop_reason = stop,
        };
    }
};

test "runAgent: 001 simple chat — single turn, end_turn" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const fixture = try loadFixture("fixtures/agent_scenarios/001_simple_chat/scenario.json");
    defer testing.allocator.free(fixture);
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena, fixture, .{});
    const scenario = parsed.object;

    // Build provider replies from scenario.
    const replies_arr = scenario.get("provider_replies").?.array.items;
    const replies = try arena.alloc(luv.Reply, replies_arr.len);
    for (replies_arr, 0..) |r, i| replies[i] = try ScenarioReplyParser.parse(arena, r);

    // Build starting conversation.
    const start_arr = scenario.get("starting_conversation").?.array.items;
    const start = try arena.alloc(luv.Message, start_arr.len);
    for (start_arr, 0..) |m_val, i| {
        const m = m_val.object;
        const role_str = m.get("role").?.string;
        const role: luv.Role = if (std.mem.eql(u8, role_str, "user")) .user else .system;
        start[i] = .{ .role = role, .text = m.get("text").?.string };
    }

    var mock = MockProvider{ .replies = replies };
    const result = try runAgent(.{
        .provider = mock.provider(),
        .model = "gpt-4o-mini",
        .conversation = start,
        .max_iterations = 5,
    }, arena);

    try testing.expectEqual(AgentFinishReason.end_turn, result.reason);
    try testing.expectEqual(@as(u32, 1), result.iterations);
    try testing.expectEqual(@as(usize, 2), result.conversation.len);
    try testing.expectEqual(luv.Role.assistant, result.conversation[1].role);
    try testing.expectEqualStrings("Hello!", result.conversation[1].text);
}

test "runAgent: 002 tool round trip — appends assistant + tool result + final assistant" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const fixture = try loadFixture("fixtures/agent_scenarios/002_tool_round_trip/scenario.json");
    defer testing.allocator.free(fixture);
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena, fixture, .{});
    const scenario = parsed.object;

    const replies_arr = scenario.get("provider_replies").?.array.items;
    const replies = try arena.alloc(luv.Reply, replies_arr.len);
    for (replies_arr, 0..) |r, i| replies[i] = try ScenarioReplyParser.parse(arena, r);

    const start_arr = scenario.get("starting_conversation").?.array.items;
    const start = try arena.alloc(luv.Message, start_arr.len);
    for (start_arr, 0..) |m_val, i| {
        const m = m_val.object;
        start[i] = .{ .role = .user, .text = m.get("text").?.string };
    }

    // One tool: lookup_weather → {ok: "..."}
    const handlers_obj = scenario.get("tool_handlers").?.object;
    const tool_result_lookup = handlers_obj.get("lookup_weather").?.object;
    const lookup_result = if (tool_result_lookup.get("ok")) |ok|
        if (ok.bool) luv.ToolResult{ .ok = tool_result_lookup.get("content").?.string } else luv.ToolResult{ .err = tool_result_lookup.get("error").?.string }
    else
        luv.ToolResult{ .err = "no result" };

    const lookup_result_box = try arena.create(luv.ToolResult);
    lookup_result_box.* = lookup_result;

    const empty_schema = try std.json.parseFromSliceLeaky(std.json.Value, arena, "{}", .{});
    const tools = [_]AgentTool{.{
        .name = "lookup_weather",
        .description = "Returns current weather for a city",
        .input_schema = empty_schema,
        .handler = fixedResultHandler,
        .handler_ctx = lookup_result_box,
    }};

    var mock = MockProvider{ .replies = replies };
    const result = try runAgent(.{
        .provider = mock.provider(),
        .model = "gpt-4o-mini",
        .conversation = start,
        .tools = &tools,
        .max_iterations = 5,
    }, arena);

    try testing.expectEqual(AgentFinishReason.end_turn, result.reason);
    try testing.expectEqual(@as(u32, 2), result.iterations);
    // Tool result is colocated on the assistant message that emitted the call;
    // no separate `.tool` message. Conversation: user, assistant(+resolved call), assistant-final.
    try testing.expectEqual(@as(usize, 3), result.conversation.len);
    try testing.expectEqual(luv.Role.user, result.conversation[0].role);
    try testing.expectEqual(luv.Role.assistant, result.conversation[1].role);
    try testing.expectEqual(@as(usize, 1), result.conversation[1].tool_calls.len);
    try testing.expectEqualStrings("call_abc123", result.conversation[1].tool_calls[0].id);
    try testing.expect(result.conversation[1].tool_calls[0].result != null);
    switch (result.conversation[1].tool_calls[0].result.?) {
        .ok => |s| try testing.expect(std.mem.indexOf(u8, s, "18") != null),
        .err => try testing.expect(false),
    }
    try testing.expectEqual(luv.Role.assistant, result.conversation[2].role);
    try testing.expect(std.mem.indexOf(u8, result.conversation[2].text, "Tokyo") != null);
}

test "runAgent: 003 hits max_iterations cap" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const fixture = try loadFixture("fixtures/agent_scenarios/003_max_iterations/scenario.json");
    defer testing.allocator.free(fixture);
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena, fixture, .{});
    const scenario = parsed.object;

    const replies_arr = scenario.get("provider_replies").?.array.items;
    const replies = try arena.alloc(luv.Reply, replies_arr.len);
    for (replies_arr, 0..) |r, i| replies[i] = try ScenarioReplyParser.parse(arena, r);

    const start_arr = scenario.get("starting_conversation").?.array.items;
    const start = try arena.alloc(luv.Message, start_arr.len);
    for (start_arr, 0..) |m_val, i| {
        const m = m_val.object;
        start[i] = .{ .role = .user, .text = m.get("text").?.string };
    }

    const noop_box = try arena.create(luv.ToolResult);
    noop_box.* = luv.ToolResult{ .ok = "" };
    const empty_schema = try std.json.parseFromSliceLeaky(std.json.Value, arena, "{}", .{});
    const tools = [_]AgentTool{.{
        .name = "noop",
        .description = "does nothing",
        .input_schema = empty_schema,
        .handler = fixedResultHandler,
        .handler_ctx = noop_box,
    }};

    var mock = MockProvider{ .replies = replies };
    const result = try runAgent(.{
        .provider = mock.provider(),
        .model = "gpt-4o-mini",
        .conversation = start,
        .tools = &tools,
        .max_iterations = 2,
    }, arena);

    try testing.expectEqual(AgentFinishReason.max_iterations, result.reason);
    try testing.expectEqual(@as(u32, 3), result.iterations);
    // Two turns of (assistant + colocated tool result) = user + 2 assistants.
    try testing.expectEqual(@as(usize, 3), result.conversation.len);
    const last = result.conversation[result.conversation.len - 1];
    try testing.expectEqual(luv.Role.assistant, last.role);
    try testing.expectEqual(@as(usize, 1), last.tool_calls.len);
    try testing.expect(last.tool_calls[0].result != null);
}

test "runAgent: unknown tool produces err result" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const empty_args = try std.json.parseFromSliceLeaky(std.json.Value, arena, "{}", .{});
    const calls = [_]luv.ToolCall{.{ .id = "c1", .name = "no_such_tool", .arguments = empty_args }};
    const replies = [_]luv.Reply{
        .{
            .message = .{ .role = .assistant, .text = "", .tool_calls = &calls },
            .stop_reason = .tool_use,
        },
        .{
            .message = .{ .role = .assistant, .text = "I cannot do that." },
            .stop_reason = .end_turn,
        },
    };
    const start = [_]luv.Message{.{ .role = .user, .text = "do something impossible" }};

    var mock = MockProvider{ .replies = &replies };
    const result = try runAgent(.{
        .provider = mock.provider(),
        .model = "gpt-4o-mini",
        .conversation = &start,
        .max_iterations = 5,
    }, arena);

    try testing.expectEqual(AgentFinishReason.end_turn, result.reason);
    // Walk the assistant messages, find the call whose colocated result is .err.
    var found_err = false;
    for (result.conversation) |m| {
        if (m.role != .assistant) continue;
        for (m.tool_calls) |c| {
            const r = c.result orelse continue;
            switch (r) {
                .err => |msg| {
                    if (std.mem.indexOf(u8, msg, "no_such_tool") != null) found_err = true;
                },
                .ok => {},
            }
        }
    }
    try testing.expect(found_err);
}
