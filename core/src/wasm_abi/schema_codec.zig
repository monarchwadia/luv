//! P3 Phase A — the recursive wire codec, reflection-driven (one source).
//!
//! The wire format is a *structural serialization* of the Wire* types in
//! codec.zig. This file derives the encoder/decoder from the Zig types by
//! comptime reflection, so there is almost no hand-written schema:
//!
//!   bool        -> u8 (0/1)
//!   u8 / u32    -> raw / u32 LE
//!   f64         -> u64 LE (bitcast)
//!   []const u8  -> u32 LE len + bytes
//!   enum        -> u8 = @intFromEnum  (matches roleToByte/stopReasonToByte)
//!   ?T          -> u8 present + T
//!   []const T   -> u32 LE count + count*T
//!   struct      -> fields in declaration order (the `arena` field is skipped)
//!   union(enum) -> u8 tag + payload (tag declared, see WireToolResult)
//!
//! The only declared irregularities (codec.zig's two non-structural choices):
//!   1. `WireReply` wire order is role, stop_reason, text, tool_calls, usage
//!      — `message` is flattened and `stop_reason` is hoisted before `text`.
//!   2. `WireToolResult` tag byte is ok=1 / err=0 (inverse of enum ordinal).
//!
//! Branch-by-abstraction: codec.zig is untouched. The conformance corpus
//! (codec_conformance.json) — the existing single source of truth — is the
//! acceptance gate: this codec must reproduce the exact same bytes and
//! round-trip, proving it is byte-identical before anything is rewired.

const std = @import("std");
const codec = @import("codec.zig");
const luv = @import("../morphisms/luv/luv.zig");

const WireMessage = codec.WireMessage;
const WireToolCall = codec.WireToolCall;
const WireToolResult = codec.WireToolResult;
const WireTool = codec.WireTool;
const WireReply = codec.WireReply;
const SendRequestInput = codec.SendRequestInput;

pub const Error = error{ Truncated, InvalidTag } || std.mem.Allocator.Error;

// --- writer (generic, reflection-driven) -----------------------------------

const Writer = struct {
    buf: *std.ArrayList(u8),
    a: std.mem.Allocator,

    fn u8v(self: *Writer, v: u8) !void {
        try self.buf.append(self.a, v);
    }
    fn u32v(self: *Writer, v: u32) !void {
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, v, .little);
        try self.buf.appendSlice(self.a, &b);
    }
    fn u64v(self: *Writer, v: u64) !void {
        var b: [8]u8 = undefined;
        std.mem.writeInt(u64, &b, v, .little);
        try self.buf.appendSlice(self.a, &b);
    }
    fn bytes(self: *Writer, s: []const u8) !void {
        try self.u32v(@intCast(s.len));
        try self.buf.appendSlice(self.a, s);
    }
};

/// Encode any supported value by reflecting its Zig type.
fn enc(w: *Writer, comptime T: type, v: T) Error!void {
    if (T == []const u8) return w.bytes(v);
    switch (@typeInfo(T)) {
        .bool => try w.u8v(if (v) 1 else 0),
        .int => |i| switch (i.bits) {
            8 => try w.u8v(v),
            32 => try w.u32v(v),
            else => @compileError("unsupported int width"),
        },
        .float => try w.u64v(@bitCast(@as(f64, v))),
        .@"enum" => try w.u8v(@intFromEnum(v)),
        .optional => |o| {
            if (v) |inner| {
                try w.u8v(1);
                try enc(w, o.child, inner);
            } else try w.u8v(0);
        },
        .pointer => |p| {
            comptime std.debug.assert(p.size == .slice and p.child != u8);
            try w.u32v(@intCast(v.len));
            for (v) |item| try enc(w, p.child, item);
        },
        .@"union" => try encUnion(w, T, v),
        .@"struct" => {
            inline for (@typeInfo(T).@"struct".fields) |f| {
                if (comptime std.mem.eql(u8, f.name, "arena")) continue;
                try enc(w, f.type, @field(v, f.name));
            }
        },
        else => @compileError("unsupported type: " ++ @typeName(T)),
    }
}

// WireToolResult: u8 tag (ok=1, err=0) then the content bytes.
fn encUnion(w: *Writer, comptime T: type, v: T) Error!void {
    comptime std.debug.assert(T == WireToolResult);
    switch (v) {
        .ok => |s| {
            try w.u8v(1);
            try w.bytes(s);
        },
        .err => |s| {
            try w.u8v(0);
            try w.bytes(s);
        },
    }
}

// --- reader (generic, reflection-driven) -----------------------------------

const Reader = struct {
    bytes: []const u8,
    pos: usize = 0,
    a: std.mem.Allocator,

    fn need(self: *Reader, n: usize) Error!void {
        if (self.pos + n > self.bytes.len) return error.Truncated;
    }
    fn u8v(self: *Reader) Error!u8 {
        try self.need(1);
        defer self.pos += 1;
        return self.bytes[self.pos];
    }
    fn u32v(self: *Reader) Error!u32 {
        try self.need(4);
        defer self.pos += 4;
        return std.mem.readInt(u32, self.bytes[self.pos..][0..4], .little);
    }
    fn u64v(self: *Reader) Error!u64 {
        try self.need(8);
        defer self.pos += 8;
        return std.mem.readInt(u64, self.bytes[self.pos..][0..8], .little);
    }
    fn blob(self: *Reader) Error![]const u8 {
        const n = try self.u32v();
        try self.need(n);
        defer self.pos += n;
        return self.a.dupe(u8, self.bytes[self.pos .. self.pos + n]);
    }
};

fn dec(r: *Reader, comptime T: type) Error!T {
    if (T == []const u8) return r.blob();
    switch (@typeInfo(T)) {
        .bool => return (try r.u8v()) != 0,
        .int => |i| return switch (i.bits) {
            8 => try r.u8v(),
            32 => try r.u32v(),
            else => @compileError("unsupported int width"),
        },
        .float => return @as(f64, @bitCast(try r.u64v())),
        .@"enum" => return @enumFromInt(try r.u8v()),
        .optional => |o| {
            if ((try r.u8v()) == 0) return null;
            return try dec(r, o.child);
        },
        .pointer => |p| {
            comptime std.debug.assert(p.size == .slice and p.child != u8);
            const n = try r.u32v();
            const items = try r.a.alloc(p.child, n);
            for (items) |*it| it.* = try dec(r, p.child);
            return items;
        },
        .@"union" => return try decUnion(r, T),
        .@"struct" => {
            var out: T = undefined;
            inline for (@typeInfo(T).@"struct".fields) |f| {
                if (comptime std.mem.eql(u8, f.name, "arena")) continue;
                @field(out, f.name) = try dec(r, f.type);
            }
            return out;
        },
        else => @compileError("unsupported type: " ++ @typeName(T)),
    }
}

fn decUnion(r: *Reader, comptime T: type) Error!T {
    comptime std.debug.assert(T == WireToolResult);
    const tag = try r.u8v();
    const content = try r.blob();
    return switch (tag) {
        1 => WireToolResult{ .ok = content },
        0 => WireToolResult{ .err = content },
        else => error.InvalidTag,
    };
}

// --- public messages -------------------------------------------------------
//
// SendRequest / Conversation are pure struct-order — fully reflection-driven.
// Reply is the one declared reorder.

pub fn encodeSendRequest(a: std.mem.Allocator, req: SendRequestInput) Error![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(a);
    var w = Writer{ .buf = &buf, .a = a };
    try enc(&w, []const u8, req.model);
    try enc(&w, []const WireMessage, req.messages);
    try enc(&w, ?u32, req.max_tokens);
    try enc(&w, ?f64, req.temperature);
    try enc(&w, bool, req.stream);
    try enc(&w, []const WireTool, req.tools);
    return buf.toOwnedSlice(a);
}

pub fn decodeSendRequest(a: std.mem.Allocator, bytes: []const u8) Error!SendRequestInput {
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    var r = Reader{ .bytes = bytes, .a = arena.allocator() };
    const model = try dec(&r, []const u8);
    const messages = try dec(&r, []const WireMessage);
    const max_tokens = try dec(&r, ?u32);
    const temperature = try dec(&r, ?f64);
    const stream = try dec(&r, bool);
    const tools = try dec(&r, []const WireTool);
    return .{
        .arena = arena,
        .model = model,
        .messages = messages,
        .max_tokens = max_tokens,
        .temperature = temperature,
        .stream = stream,
        .tools = tools,
    };
}

pub fn encodeConversation(a: std.mem.Allocator, messages: []const WireMessage) Error![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(a);
    var w = Writer{ .buf = &buf, .a = a };
    try enc(&w, []const WireMessage, messages);
    return buf.toOwnedSlice(a);
}

/// Declared reorder: role, stop_reason, text, tool_calls, usage.
pub fn encodeReply(a: std.mem.Allocator, reply: WireReply) Error![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(a);
    var w = Writer{ .buf = &buf, .a = a };
    try enc(&w, luv.Role, reply.message.role);
    try enc(&w, luv.StopReason, reply.stop_reason);
    try enc(&w, []const u8, reply.message.text);
    try enc(&w, []const WireToolCall, reply.message.tool_calls);
    try enc(&w, ?luv.Usage, reply.usage);
    return buf.toOwnedSlice(a);
}

// --- conformance gate: identical bytes to codec.zig, via the same corpus ---

const testing = std.testing;

const CorpusUsage = struct { prompt: u32, completion: u32, total: u32 };
const CorpusTCResult = struct { ok: bool, content: []const u8 };
const CorpusTC = struct {
    id: []const u8,
    name: []const u8,
    args: []const u8,
    result: ?CorpusTCResult = null,
};
const CorpusMsg = struct {
    role: u8,
    text: []const u8,
    toolCalls: []const CorpusTC = &.{},
};
const CorpusTool = struct {
    name: []const u8,
    description: []const u8,
    inputSchema: []const u8,
};
const CorpusReplyCase = struct {
    name: []const u8,
    value: struct {
        role: u8,
        stopReason: u8,
        text: []const u8,
        toolCalls: []const CorpusTC = &.{},
        usage: ?CorpusUsage = null,
    },
    hex: []const u8,
};
const CorpusSendReqCase = struct {
    name: []const u8,
    hex: []const u8,
    value: struct {
        model: []const u8,
        messages: []const CorpusMsg,
        maxTokens: ?u32 = null,
        temperature: ?f64 = null,
        stream: bool,
        tools: []const CorpusTool = &.{},
    },
};
const Corpus = struct {
    encodeReply: []const CorpusReplyCase,
    decodeSendRequest: []const CorpusSendReqCase,
};

fn wireCalls(a: std.mem.Allocator, tcs: []const CorpusTC) ![]WireToolCall {
    const out = try a.alloc(WireToolCall, tcs.len);
    for (tcs, 0..) |tc, j| out[j] = .{
        .id = tc.id,
        .name = tc.name,
        .args = tc.args,
        .result = if (tc.result) |rr|
            (if (rr.ok) WireToolResult{ .ok = rr.content } else WireToolResult{ .err = rr.content })
        else
            null,
    };
    return out;
}

test "schema_codec: byte-identical to codec.zig over the conformance corpus" {
    const json_bytes = @embedFile("codec_conformance.json");
    const parsed = try std.json.parseFromSlice(
        Corpus,
        testing.allocator,
        json_bytes,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    const corpus = parsed.value;
    var hexbuf: [1024]u8 = undefined;

    for (corpus.encodeReply) |c| {
        const wcalls = try wireCalls(testing.allocator, c.value.toolCalls);
        defer testing.allocator.free(wcalls);
        const usage: ?luv.Usage = if (c.value.usage) |u|
            .{ .prompt_tokens = u.prompt, .completion_tokens = u.completion, .total_tokens = u.total }
        else
            null;
        const reply: WireReply = .{
            .message = .{
                .role = @enumFromInt(c.value.role),
                .text = c.value.text,
                .tool_calls = wcalls,
            },
            .stop_reason = @enumFromInt(c.value.stopReason),
            .usage = usage,
        };
        const got = try encodeReply(testing.allocator, reply);
        defer testing.allocator.free(got);
        const exp = try std.fmt.hexToBytes(&hexbuf, c.hex);
        testing.expectEqualSlices(u8, exp, got) catch |e| {
            std.debug.print("schema encodeReply '{s}' mismatch\n", .{c.name});
            return e;
        };
    }

    for (corpus.decodeSendRequest) |c| {
        const in = try std.fmt.hexToBytes(&hexbuf, c.hex);
        var req = try decodeSendRequest(testing.allocator, in);
        defer req.deinit(testing.allocator);
        try testing.expectEqualStrings(c.value.model, req.model);
        try testing.expectEqual(c.value.messages.len, req.messages.len);
        for (c.value.messages, 0..) |em, i| {
            const rm = req.messages[i];
            try testing.expectEqual(@as(luv.Role, @enumFromInt(em.role)), rm.role);
            try testing.expectEqualStrings(em.text, rm.text);
            try testing.expectEqual(em.toolCalls.len, rm.tool_calls.len);
            for (em.toolCalls, 0..) |etc, j| {
                const rtc = rm.tool_calls[j];
                try testing.expectEqualStrings(etc.id, rtc.id);
                try testing.expectEqualStrings(etc.name, rtc.name);
                try testing.expectEqualStrings(etc.args, rtc.args);
                if (etc.result) |er| {
                    try testing.expect(rtc.result != null);
                    switch (rtc.result.?) {
                        .ok => |s| {
                            try testing.expect(er.ok);
                            try testing.expectEqualStrings(er.content, s);
                        },
                        .err => |s| {
                            try testing.expect(!er.ok);
                            try testing.expectEqualStrings(er.content, s);
                        },
                    }
                } else try testing.expect(rtc.result == null);
            }
        }
        try testing.expectEqual(c.value.maxTokens, req.max_tokens);
        try testing.expectEqual(c.value.temperature, req.temperature);
        try testing.expectEqual(c.value.stream, req.stream);
        try testing.expectEqual(c.value.tools.len, req.tools.len);
        for (c.value.tools, 0..) |et, ti| {
            try testing.expectEqualStrings(et.name, req.tools[ti].name);
            try testing.expectEqualStrings(et.description, req.tools[ti].description);
            try testing.expectEqualStrings(et.inputSchema, req.tools[ti].input_schema);
        }

        // Round-trip: re-encode must reproduce the exact corpus bytes,
        // proving the schema codec is the inverse pair codec.zig is.
        const re = try encodeSendRequest(testing.allocator, req);
        defer testing.allocator.free(re);
        testing.expectEqualSlices(u8, in, re) catch |e| {
            std.debug.print("schema encodeSendRequest round-trip '{s}' mismatch\n", .{c.name});
            return e;
        };
    }
}
