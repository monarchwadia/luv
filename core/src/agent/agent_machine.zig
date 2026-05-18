//! Sans-IO agent loop (Stream E). Same orchestration as `runAgent` in
//! agent.zig, but as a poll/feed state machine: `provider.send` and tool
//! execution become emitted effects the host performs, so the loop runs in
//! freestanding wasm. The pure logic (iteration / max_iterations / abort /
//! pending-tool extraction / threading results / finish reason) lives here;
//! the host derives the on_turn_start/on_tool_call/on_tool_result/on_finish
//! lifecycle hooks from the effect stream (turn_start before provider_send,
//! tool_call per emitted call, tool_result on feed, finish on done) — exact
//! same ordering as agent.zig.

const std = @import("std");
const luv = @import("../morphisms/luv/luv.zig");

pub const FinishReason = enum { end_turn, max_iterations, aborted, @"error" };

pub const SendParams = struct {
    conversation: []const luv.Message,
    model: []const u8,
    tools: []const luv.Tool,
    max_tokens: ?u32,
    temperature: ?f64,
};

pub const AgentResult = struct {
    conversation: []const luv.Message,
    reason: FinishReason,
    iterations: u32,
};

/// poll() outcome: perform a provider send, perform a tool-call batch, or done.
pub const Poll = union(enum) {
    provider_send: SendParams,
    tool_calls: []const luv.ToolCall,
    done: AgentResult,
};

pub const MachineError = error{
    /// poll() while an effect is outstanding (host must feed first).
    NotResumed,
    /// feed*() with no matching outstanding effect / wrong batch size.
    BadFeed,
} || std.mem.Allocator.Error;

pub const Options = struct {
    conversation: []const luv.Message,
    model: []const u8,
    tools: []const luv.Tool = &.{},
    max_tokens: ?u32 = null,
    temperature: ?f64 = null,
    max_iterations: u32 = 10,
};

pub const AgentMachine = struct {
    arena: std.heap.ArenaAllocator,
    conversation: std.ArrayList(luv.Message),
    model: []const u8,
    tools: []const luv.Tool,
    max_tokens: ?u32,
    temperature: ?f64,
    max_iterations: u32,
    iterations: u32 = 0,
    aborted: bool = false,
    state: enum { ready, awaiting_reply, tools_ready, awaiting_tools, finished } = .ready,
    pending: []luv.ToolCall = &.{}, // owned calls on the last message
    result: ?AgentResult = null,

    pub fn init(child: std.mem.Allocator, opts: Options) MachineError!AgentMachine {
        var arena = std.heap.ArenaAllocator.init(child);
        errdefer arena.deinit();
        const a = arena.allocator();
        var conv: std.ArrayList(luv.Message) = .empty;
        try conv.appendSlice(a, opts.conversation);
        return .{
            .arena = arena,
            .conversation = conv,
            .model = opts.model,
            .tools = opts.tools,
            .max_tokens = opts.max_tokens,
            .temperature = opts.temperature,
            .max_iterations = opts.max_iterations,
        };
    }

    pub fn deinit(self: *AgentMachine) void {
        self.arena.deinit();
        self.* = undefined;
    }

    /// Host signals the abort signal fired — the loop terminates on the next
    /// poll with reason .aborted (matches agent.zig's isAborted checks).
    pub fn abort(self: *AgentMachine) void {
        self.aborted = true;
    }

    fn finish(self: *AgentMachine, reason: FinishReason) MachineError!Poll {
        self.result = .{
            .conversation = self.conversation.items,
            .reason = reason,
            .iterations = self.iterations,
        };
        self.state = .finished;
        return .{ .done = self.result.? };
    }

    pub fn poll(self: *AgentMachine) MachineError!Poll {
        switch (self.state) {
            .finished => return .{ .done = self.result.? },
            .awaiting_reply, .awaiting_tools => {
                if (self.aborted) return self.finish(.aborted);
                return error.NotResumed;
            },
            .tools_ready => {
                if (self.aborted) return self.finish(.aborted);
                self.state = .awaiting_tools;
                return .{ .tool_calls = self.pending };
            },
            .ready => {
                self.iterations += 1;
                if (self.aborted) return self.finish(.aborted);
                if (self.iterations > self.max_iterations) return self.finish(.max_iterations);
                self.state = .awaiting_reply;
                return .{ .provider_send = .{
                    .conversation = self.conversation.items,
                    .model = self.model,
                    .tools = self.tools,
                    .max_tokens = self.max_tokens,
                    .temperature = self.temperature,
                } };
            },
        }
    }

    /// Feed the provider reply (response to a provider_send effect). The host
    /// signals a provider failure with `error_reply = true` → finish(.error).
    pub fn feedReply(self: *AgentMachine, reply: luv.Reply, provider_failed: bool) MachineError!void {
        if (self.state != .awaiting_reply) return error.BadFeed;
        if (provider_failed) {
            _ = try self.finish(.@"error");
            return;
        }
        try self.conversation.append(self.arena.allocator(), reply.message);
        const calls = if (reply.message.role == .assistant)
            reply.message.tool_calls
        else
            &.{};
        if (calls.len == 0) {
            _ = try self.finish(.end_turn);
            return;
        }
        const owned = try self.arena.allocator().alloc(luv.ToolCall, calls.len);
        for (calls, 0..) |c, i| owned[i] = c;
        self.conversation.items[self.conversation.items.len - 1].tool_calls = owned;
        self.pending = owned;
        self.state = .tools_ready;
    }

    /// Feed one ToolResult per emitted tool call, in order.
    pub fn feedToolResults(self: *AgentMachine, results: []const luv.ToolResult) MachineError!void {
        if (self.state != .awaiting_tools) return error.BadFeed;
        if (results.len != self.pending.len) return error.BadFeed;
        for (results, 0..) |r, i| self.pending[i].result = r;
        self.pending = &.{};
        self.state = .ready;
    }
};

// ---------------------------------------------------------------------------
// Tests — drive the machine with mock effect feeds (host stand-in).

const testing = std.testing;

fn jsonEmpty() std.json.Value {
    return .{ .object = .{} };
}

test "AgentMachine: single turn, no tools -> end_turn" {
    var m = try AgentMachine.init(testing.allocator, .{
        .conversation = &.{.{ .role = .user, .text = "hi" }},
        .model = "m",
    });
    defer m.deinit();

    const p1 = try m.poll();
    try testing.expect(p1 == .provider_send);
    try testing.expectEqual(@as(usize, 1), p1.provider_send.conversation.len);

    try m.feedReply(.{
        .message = .{ .role = .assistant, .text = "hello" },
        .stop_reason = .end_turn,
    }, false);

    const p2 = try m.poll();
    try testing.expect(p2 == .done);
    try testing.expectEqual(FinishReason.end_turn, p2.done.reason);
    try testing.expectEqual(@as(u32, 1), p2.done.iterations);
    try testing.expectEqual(@as(usize, 2), p2.done.conversation.len);
}

test "AgentMachine: tool-call turn then end_turn" {
    var m = try AgentMachine.init(testing.allocator, .{
        .conversation = &.{.{ .role = .user, .text = "weather?" }},
        .model = "m",
    });
    defer m.deinit();

    _ = try m.poll(); // provider_send #1
    const calls = [_]luv.ToolCall{.{ .id = "c1", .name = "wx", .arguments = jsonEmpty() }};
    try m.feedReply(.{
        .message = .{ .role = .assistant, .text = "", .tool_calls = &calls },
        .stop_reason = .tool_use,
    }, false);

    const pt = try m.poll();
    try testing.expect(pt == .tool_calls);
    try testing.expectEqual(@as(usize, 1), pt.tool_calls.len);
    try testing.expectEqualStrings("c1", pt.tool_calls[0].id);

    try m.feedToolResults(&.{.{ .ok = "{\"t\":18}" }});

    _ = try m.poll(); // provider_send #2
    try m.feedReply(.{
        .message = .{ .role = .assistant, .text = "It's 18C." },
        .stop_reason = .end_turn,
    }, false);

    const pd = try m.poll();
    try testing.expect(pd == .done);
    try testing.expectEqual(FinishReason.end_turn, pd.done.reason);
    try testing.expectEqual(@as(u32, 2), pd.done.iterations);
    // user, assistant(tool_calls w/ result), assistant(final)
    try testing.expectEqual(@as(usize, 3), pd.done.conversation.len);
    try testing.expect(pd.done.conversation[1].tool_calls[0].result != null);
}

test "AgentMachine: max_iterations" {
    var m = try AgentMachine.init(testing.allocator, .{
        .conversation = &.{.{ .role = .user, .text = "loop" }},
        .model = "m",
        .max_iterations = 2,
    });
    defer m.deinit();

    var turns: u32 = 0;
    while (true) {
        const p = try m.poll();
        if (p == .done) {
            try testing.expectEqual(FinishReason.max_iterations, p.done.reason);
            try testing.expectEqual(@as(u32, 3), p.done.iterations);
            break;
        }
        turns += 1;
        try testing.expect(turns <= 3);
        // Always reply with a tool call so the loop never ends on its own.
        const calls = [_]luv.ToolCall{.{ .id = "c", .name = "n", .arguments = jsonEmpty() }};
        try m.feedReply(.{
            .message = .{ .role = .assistant, .text = "", .tool_calls = &calls },
            .stop_reason = .tool_use,
        }, false);
        const pt = try m.poll();
        try testing.expect(pt == .tool_calls);
        try m.feedToolResults(&.{.{ .ok = "x" }});
    }
}

test "AgentMachine: abort terminates with .aborted" {
    var m = try AgentMachine.init(testing.allocator, .{
        .conversation = &.{.{ .role = .user, .text = "hi" }},
        .model = "m",
    });
    defer m.deinit();
    _ = try m.poll(); // provider_send
    m.abort();
    const p = try m.poll();
    try testing.expect(p == .done);
    try testing.expectEqual(FinishReason.aborted, p.done.reason);
}

test "AgentMachine: provider failure -> .error" {
    var m = try AgentMachine.init(testing.allocator, .{
        .conversation = &.{.{ .role = .user, .text = "hi" }},
        .model = "m",
    });
    defer m.deinit();
    _ = try m.poll();
    try m.feedReply(undefined, true);
    const p = try m.poll();
    try testing.expect(p == .done);
    try testing.expectEqual(FinishReason.@"error", p.done.reason);
}

test "AgentMachine: poll before feed errors NotResumed" {
    var m = try AgentMachine.init(testing.allocator, .{
        .conversation = &.{.{ .role = .user, .text = "hi" }},
        .model = "m",
    });
    defer m.deinit();
    _ = try m.poll();
    try testing.expectError(error.NotResumed, m.poll());
}
