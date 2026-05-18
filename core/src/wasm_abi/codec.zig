//! Binary codec for the wasm ↔ JS boundary.
//!
//! Little-endian throughout. Strings are u32 length-prefixed UTF-8.
//! Optional<T> is encoded as `u8 present` followed by T (if present == 1).
//!
//! Stub. Tests below intentionally fail until the implementation lands.
//!
//! Wire format reference (matches lib/js/src/codec.ts on the JS side):
//!
//! SendRequest:
//!   u32   model_len
//!   u8[]  model
//!   u32   message_count
//!   Message[message_count]
//!   u8    max_tokens_present
//!   u32   max_tokens          (only if present)
//!   u8    temperature_present
//!   f32   temperature         (only if present)
//!   u8    stream              (0|1)
//!
//! Message:
//!   u8    role                (0=system, 1=user, 2=assistant)
//!   u32   text_len
//!   u8[]  text
//!
//! Reply:
//!   u8    role
//!   u8    stop_reason         (0=end_turn, 1=max_tokens, 2=content_filter,
//!                              3=stop_sequence, 4=tool_use, 5=other)
//!   u32   text_len
//!   u8[]  text
//!
//! EventBatch:
//!   u32   event_count
//!   Event[event_count]
//!
//! Event:
//!   u8    kind                (0=start, 1=text, 2=stop)
//!   start: u8 role
//!   text:  u32 delta_len; u8[] delta
//!   stop:  u8 stop_reason

const std = @import("std");
const luv = @import("../morphisms/luv/luv.zig");
const luv_stream = @import("../morphisms/luv/luv_stream.zig");

pub const WireToolResult = union(enum) {
    ok: []const u8,
    err: []const u8,
};

pub const WireToolCall = struct {
    id: []const u8,
    name: []const u8,
    /// Opaque JSON bytes — the codec never parses these (codec boundary:
    /// JSON lives at the morphism boundary, not in the wire codec).
    args: []const u8,
    result: ?WireToolResult = null,
};

pub const WireMessage = struct {
    role: luv.Role,
    text: []const u8,
    tool_calls: []const WireToolCall = &.{},
};

pub const WireTool = struct {
    name: []const u8,
    description: []const u8,
    /// Opaque JSON Schema bytes — codec never parses (parsed at the
    /// morphism boundary, same as tool-call args).
    input_schema: []const u8,
};

pub const SendRequestInput = struct {
    arena: std.heap.ArenaAllocator,
    model: []const u8,
    messages: []const WireMessage,
    max_tokens: ?u32,
    temperature: ?f64,
    stream: bool,
    tools: []const WireTool = &.{},

    /// All decoded memory is arena-owned; the alloc param is ignored (kept
    /// for call-site compatibility). Single free, leak-safe on every path.
    pub fn deinit(self: *SendRequestInput, _: std.mem.Allocator) void {
        self.arena.deinit();
        self.* = undefined;
    }
};

/// Codec-level reply: tool-call args are opaque JSON bytes (stringified at
/// the exports/morphism boundary, same as the request side — codec stays
/// std.json-free).
pub const WireReply = struct {
    message: WireMessage,
    stop_reason: luv.StopReason,
    usage: ?luv.Usage = null,
};

pub fn toolCallsSize(calls: []const WireToolCall) usize {
    var n: usize = 4;
    for (calls) |c| {
        n += 4 + c.id.len + 4 + c.name.len + 4 + c.args.len + 1;
        if (c.result) |rr| n += 1 + 4 + (switch (rr) {
            .ok => |s| s.len,
            .err => |s| s.len,
        });
    }
    return n;
}

pub fn writeToolCalls(out: []u8, pos: *usize, calls: []const WireToolCall) void {
    std.mem.writeInt(u32, out[pos.*..][0..4], @intCast(calls.len), .little);
    pos.* += 4;
    for (calls) |c| {
        inline for (.{ c.id, c.name, c.args }) |field| {
            std.mem.writeInt(u32, out[pos.*..][0..4], @intCast(field.len), .little);
            pos.* += 4;
            @memcpy(out[pos.* .. pos.* + field.len], field);
            pos.* += field.len;
        }
        if (c.result) |rr| {
            out[pos.*] = 1;
            pos.* += 1;
            const content: []const u8 = switch (rr) {
                .ok => |s| blk: {
                    out[pos.*] = 1;
                    break :blk s;
                },
                .err => |s| blk: {
                    out[pos.*] = 0;
                    break :blk s;
                },
            };
            pos.* += 1;
            std.mem.writeInt(u32, out[pos.*..][0..4], @intCast(content.len), .little);
            pos.* += 4;
            @memcpy(out[pos.* .. pos.* + content.len], content);
            pos.* += content.len;
        } else {
            out[pos.*] = 0;
            pos.* += 1;
        }
    }
}

pub const DecodeError = error{
    Truncated,
    InvalidRole,
    InvalidStopReason,
    InvalidEventKind,
} || std.mem.Allocator.Error;

const Reader = struct {
    bytes: []const u8,
    pos: usize = 0,

    fn need(self: *Reader, n: usize) DecodeError!void {
        if (self.pos + n > self.bytes.len) return error.Truncated;
    }

    fn readU8(self: *Reader) DecodeError!u8 {
        try self.need(1);
        const v = self.bytes[self.pos];
        self.pos += 1;
        return v;
    }

    fn readU32(self: *Reader) DecodeError!u32 {
        try self.need(4);
        const v = std.mem.readInt(u32, self.bytes[self.pos..][0..4], .little);
        self.pos += 4;
        return v;
    }

    fn readF64(self: *Reader) DecodeError!f64 {
        try self.need(8);
        const v = @as(f64, @bitCast(std.mem.readInt(u64, self.bytes[self.pos..][0..8], .little)));
        self.pos += 8;
        return v;
    }

    fn readSliceDup(self: *Reader, len: usize, alloc: std.mem.Allocator) DecodeError![]u8 {
        try self.need(len);
        const out = try alloc.dupe(u8, self.bytes[self.pos .. self.pos + len]);
        self.pos += len;
        return out;
    }
};

fn roleFromByte(b: u8) DecodeError!luv.Role {
    return switch (b) {
        0 => .system,
        1 => .user,
        2 => .assistant,
        else => error.InvalidRole,
    };
}

fn roleToByte(r: luv.Role) u8 {
    return switch (r) {
        .system => 0,
        .user => 1,
        .assistant => 2,
    };
}

fn stopReasonToByte(s: luv.StopReason) u8 {
    return switch (s) {
        .end_turn => 0,
        .max_tokens => 1,
        .content_filter => 2,
        .stop_sequence => 3,
        .tool_use => 4,
        .other => 5,
    };
}

pub fn decodeSendRequest(bytes: []const u8, alloc: std.mem.Allocator) DecodeError!SendRequestInput {
    var arena = std.heap.ArenaAllocator.init(alloc);
    errdefer arena.deinit();
    const a = arena.allocator();

    var r: Reader = .{ .bytes = bytes };

    const model_len = try r.readU32();
    const model = try r.readSliceDup(model_len, a);

    const message_count = try r.readU32();
    const messages = try a.alloc(WireMessage, message_count);

    var i: usize = 0;
    while (i < message_count) : (i += 1) {
        const role = try roleFromByte(try r.readU8());
        const text_len = try r.readU32();
        const text = try r.readSliceDup(text_len, a);

        const tc_count = try r.readU32();
        const calls = try a.alloc(WireToolCall, tc_count);
        var cj: usize = 0;
        while (cj < tc_count) : (cj += 1) {
            const id_len = try r.readU32();
            const id = try r.readSliceDup(id_len, a);
            const name_len = try r.readU32();
            const name = try r.readSliceDup(name_len, a);
            const args_len = try r.readU32();
            const args = try r.readSliceDup(args_len, a);
            const res_present = try r.readU8();
            var result: ?WireToolResult = null;
            if (res_present != 0) {
                const ok = try r.readU8();
                const rlen = try r.readU32();
                const content = try r.readSliceDup(rlen, a);
                result = if (ok != 0) .{ .ok = content } else .{ .err = content };
            }
            calls[cj] = .{ .id = id, .name = name, .args = args, .result = result };
        }

        messages[i] = .{ .role = role, .text = text, .tool_calls = calls };
    }

    const max_tokens_present = try r.readU8();
    const max_tokens: ?u32 = if (max_tokens_present == 0) null else try r.readU32();

    const temperature_present = try r.readU8();
    const temperature: ?f64 = if (temperature_present == 0) null else try r.readF64();

    const stream_byte = try r.readU8();

    const tool_count = try r.readU32();
    const tools = try a.alloc(WireTool, tool_count);
    var ti: usize = 0;
    while (ti < tool_count) : (ti += 1) {
        const name_len = try r.readU32();
        const name = try r.readSliceDup(name_len, a);
        const desc_len = try r.readU32();
        const description = try r.readSliceDup(desc_len, a);
        const schema_len = try r.readU32();
        const input_schema = try r.readSliceDup(schema_len, a);
        tools[ti] = .{ .name = name, .description = description, .input_schema = input_schema };
    }

    return .{
        .arena = arena,
        .model = model,
        .messages = messages,
        .max_tokens = max_tokens,
        .temperature = temperature,
        .stream = stream_byte != 0,
        .tools = tools,
    };
}

/// Symmetric encoder for SendRequest (test/conformance oracle + lets the
/// corpus be implementation-derived rather than hand-computed hex). Mirrors
/// decodeSendRequest's wire exactly.
pub fn encodeSendRequest(req: SendRequestInput, alloc: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
    var total: usize = 4 + req.model.len + 4;
    for (req.messages) |m| {
        total += 1 + 4 + m.text.len + 4;
        for (m.tool_calls) |c| {
            total += 4 + c.id.len + 4 + c.name.len + 4 + c.args.len + 1;
            if (c.result) |rr| total += 1 + 4 + (switch (rr) {
                .ok => |s| s.len,
                .err => |s| s.len,
            });
        }
    }
    total += 1 + (if (req.max_tokens != null) @as(usize, 4) else 0);
    total += 1 + (if (req.temperature != null) @as(usize, 8) else 0);
    total += 1;
    total += 4;
    for (req.tools) |t| total += 4 + t.name.len + 4 + t.description.len + 4 + t.input_schema.len;

    const out = try alloc.alloc(u8, total);
    errdefer alloc.free(out);
    var pos: usize = 0;

    std.mem.writeInt(u32, out[pos..][0..4], @intCast(req.model.len), .little);
    pos += 4;
    @memcpy(out[pos .. pos + req.model.len], req.model);
    pos += req.model.len;

    std.mem.writeInt(u32, out[pos..][0..4], @intCast(req.messages.len), .little);
    pos += 4;
    for (req.messages) |m| {
        out[pos] = roleToByte(m.role);
        pos += 1;
        std.mem.writeInt(u32, out[pos..][0..4], @intCast(m.text.len), .little);
        pos += 4;
        @memcpy(out[pos .. pos + m.text.len], m.text);
        pos += m.text.len;

        std.mem.writeInt(u32, out[pos..][0..4], @intCast(m.tool_calls.len), .little);
        pos += 4;
        for (m.tool_calls) |c| {
            inline for (.{ c.id, c.name, c.args }) |field| {
                std.mem.writeInt(u32, out[pos..][0..4], @intCast(field.len), .little);
                pos += 4;
                @memcpy(out[pos .. pos + field.len], field);
                pos += field.len;
            }
            if (c.result) |rr| {
                out[pos] = 1;
                pos += 1;
                const content: []const u8 = switch (rr) {
                    .ok => |s| blk: {
                        out[pos] = 1;
                        break :blk s;
                    },
                    .err => |s| blk: {
                        out[pos] = 0;
                        break :blk s;
                    },
                };
                pos += 1;
                std.mem.writeInt(u32, out[pos..][0..4], @intCast(content.len), .little);
                pos += 4;
                @memcpy(out[pos .. pos + content.len], content);
                pos += content.len;
            } else {
                out[pos] = 0;
                pos += 1;
            }
        }
    }

    if (req.max_tokens) |mt| {
        out[pos] = 1;
        pos += 1;
        std.mem.writeInt(u32, out[pos..][0..4], mt, .little);
        pos += 4;
    } else {
        out[pos] = 0;
        pos += 1;
    }

    if (req.temperature) |tp| {
        out[pos] = 1;
        pos += 1;
        std.mem.writeInt(u64, out[pos..][0..8], @bitCast(tp), .little);
        pos += 8;
    } else {
        out[pos] = 0;
        pos += 1;
    }

    out[pos] = if (req.stream) 1 else 0;
    pos += 1;

    std.mem.writeInt(u32, out[pos..][0..4], @intCast(req.tools.len), .little);
    pos += 4;
    for (req.tools) |t| {
        inline for (.{ t.name, t.description, t.input_schema }) |field| {
            std.mem.writeInt(u32, out[pos..][0..4], @intCast(field.len), .little);
            pos += 4;
            @memcpy(out[pos .. pos + field.len], field);
            pos += field.len;
        }
    }

    std.debug.assert(pos == total);
    return out;
}

pub fn encodeReply(reply: WireReply, alloc: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
    const m = reply.message;
    var total: usize = 1 + 1 + 4 + m.text.len;
    total += toolCallsSize(m.tool_calls);
    total += 1 + (if (reply.usage != null) @as(usize, 12) else 0);

    const out = try alloc.alloc(u8, total);
    errdefer alloc.free(out);
    var pos: usize = 0;

    out[pos] = roleToByte(m.role);
    pos += 1;
    out[pos] = stopReasonToByte(reply.stop_reason);
    pos += 1;
    std.mem.writeInt(u32, out[pos..][0..4], @intCast(m.text.len), .little);
    pos += 4;
    @memcpy(out[pos .. pos + m.text.len], m.text);
    pos += m.text.len;

    writeToolCalls(out, &pos, m.tool_calls);

    if (reply.usage) |u| {
        out[pos] = 1;
        pos += 1;
        std.mem.writeInt(u32, out[pos..][0..4], u.prompt_tokens, .little);
        pos += 4;
        std.mem.writeInt(u32, out[pos..][0..4], u.completion_tokens, .little);
        pos += 4;
        std.mem.writeInt(u32, out[pos..][0..4], u.total_tokens, .little);
        pos += 4;
    } else {
        out[pos] = 0;
        pos += 1;
    }

    std.debug.assert(pos == total);
    return out;
}

/// Symmetric decoder for Reply (feeds a provider reply INTO the agent
/// machine). Strings duped with `a` (caller owns; an arena is ideal).
pub fn decodeReply(bytes: []const u8, a: std.mem.Allocator) DecodeError!WireReply {
    var r: Reader = .{ .bytes = bytes };
    const role = try roleFromByte(try r.readU8());
    const stop = stopReasonFromByte(try r.readU8());
    const text = try r.readSliceDup(try r.readU32(), a);
    const calls = try readToolCalls(&r, a);
    var usage: ?luv.Usage = null;
    if (try r.readU8() != 0) {
        usage = .{
            .prompt_tokens = try r.readU32(),
            .completion_tokens = try r.readU32(),
            .total_tokens = try r.readU32(),
        };
    }
    return .{
        .message = .{ .role = role, .text = text, .tool_calls = calls },
        .stop_reason = stop,
        .usage = usage,
    };
}

pub fn encodeEvents(events: []const luv_stream.Event, alloc: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
    var total: usize = 4; // event_count
    for (events) |e| total += switch (e) {
        .start => 2, // kind + role
        .text => |t| 1 + 4 + t.delta.len, // kind + delta_len + delta
        .stop => 2, // kind + stop_reason
    };

    var out = try alloc.alloc(u8, total);
    errdefer alloc.free(out);

    std.mem.writeInt(u32, out[0..4], @intCast(events.len), .little);
    var pos: usize = 4;
    for (events) |e| switch (e) {
        .start => |s| {
            out[pos] = 0;
            out[pos + 1] = roleToByte(s.role);
            pos += 2;
        },
        .text => |t| {
            out[pos] = 1;
            std.mem.writeInt(u32, out[pos + 1 ..][0..4], @intCast(t.delta.len), .little);
            @memcpy(out[pos + 5 .. pos + 5 + t.delta.len], t.delta);
            pos += 5 + t.delta.len;
        },
        .stop => |s| {
            out[pos] = 2;
            out[pos + 1] = stopReasonToByte(s.stop_reason);
            pos += 2;
        },
    };
    return out;
}

// ---------------------------------------------------------------------------
// Standalone conversation codec (for the tool_calls brick). Wire:
//   u32 msg_count; WireMessage[]  (same per-message shape as SendRequest).

pub const Conversation = struct {
    arena: std.heap.ArenaAllocator,
    messages: []const WireMessage,

    pub fn deinit(self: *Conversation) void {
        self.arena.deinit();
        self.* = undefined;
    }
};

fn readToolCalls(r: *Reader, a: std.mem.Allocator) DecodeError![]WireToolCall {
    const tc_count = try r.readU32();
    const calls = try a.alloc(WireToolCall, tc_count);
    var j: usize = 0;
    while (j < tc_count) : (j += 1) {
        const id = try r.readSliceDup(try r.readU32(), a);
        const name = try r.readSliceDup(try r.readU32(), a);
        const args = try r.readSliceDup(try r.readU32(), a);
        var result: ?WireToolResult = null;
        if (try r.readU8() != 0) {
            const ok = try r.readU8();
            const content = try r.readSliceDup(try r.readU32(), a);
            result = if (ok != 0) .{ .ok = content } else .{ .err = content };
        }
        calls[j] = .{ .id = id, .name = name, .args = args, .result = result };
    }
    return calls;
}

pub fn decodeConversation(bytes: []const u8, alloc: std.mem.Allocator) DecodeError!Conversation {
    var arena = std.heap.ArenaAllocator.init(alloc);
    errdefer arena.deinit();
    const a = arena.allocator();
    var r: Reader = .{ .bytes = bytes };
    const count = try r.readU32();
    const messages = try a.alloc(WireMessage, count);
    var i: usize = 0;
    while (i < count) : (i += 1) {
        const role = try roleFromByte(try r.readU8());
        const text = try r.readSliceDup(try r.readU32(), a);
        messages[i] = .{ .role = role, .text = text, .tool_calls = try readToolCalls(&r, a) };
    }
    return .{ .arena = arena, .messages = messages };
}

fn messageSize(m: WireMessage) usize {
    return 1 + 4 + m.text.len + toolCallsSize(m.tool_calls);
}

pub fn encodeConversation(messages: []const WireMessage, alloc: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
    var total: usize = 4;
    for (messages) |m| total += messageSize(m);
    const out = try alloc.alloc(u8, total);
    errdefer alloc.free(out);
    var pos: usize = 0;
    std.mem.writeInt(u32, out[0..4], @intCast(messages.len), .little);
    pos = 4;
    for (messages) |m| {
        out[pos] = roleToByte(m.role);
        pos += 1;
        std.mem.writeInt(u32, out[pos..][0..4], @intCast(m.text.len), .little);
        pos += 4;
        @memcpy(out[pos .. pos + m.text.len], m.text);
        pos += m.text.len;
        writeToolCalls(out, &pos, m.tool_calls);
    }
    std.debug.assert(pos == total);
    return out;
}

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;

test "decodeSendRequest: minimal request (model + 1 user message, no opts, no stream)" {
    // Hand-build the bytes we expect a JS encoder to produce for:
    //   model="m", messages=[{role: user, text: "hi"}], no max_tokens, no temperature, stream=false
    //
    // u32 model_len=1 | "m"
    // u32 message_count=1
    //   u8 role=1 | u32 text_len=2 | "hi"
    // u8 max_tokens_present=0
    // u8 temperature_present=0
    // u8 stream=0
    const bytes = [_]u8{
        0x01, 0x00, 0x00, 0x00, // model_len = 1
        'm',
        0x01, 0x00, 0x00, 0x00, // message_count = 1
        0x01, // role = 1 (user)
        0x02, 0x00, 0x00, 0x00, 'h', 'i', // text_len = 2, "hi"
        0x00, 0x00, 0x00, 0x00, // tool_call_count = 0
        0x00, // max_tokens_present = 0
        0x00, // temperature_present = 0
        0x00, // stream = 0
        0x00, 0x00, 0x00, 0x00, // tool_count = 0
    };

    var req = try decodeSendRequest(&bytes, testing.allocator);
    defer req.deinit(testing.allocator);

    try testing.expectEqualStrings("m", req.model);
    try testing.expectEqual(@as(usize, 1), req.messages.len);
    try testing.expectEqual(luv.Role.user, req.messages[0].role);
    try testing.expectEqualStrings("hi", req.messages[0].text);
    try testing.expectEqual(@as(?u32, null), req.max_tokens);
    try testing.expectEqual(@as(?f64, null), req.temperature);
    try testing.expectEqual(false, req.stream);
}

test "decodeSendRequest: full request (model, multi-turn, max_tokens, temperature, stream)" {
    const bytes = [_]u8{
        0x0B, 0x00, 0x00, 0x00, // model_len = 11
        'g',  'p',  't',  '-',
        '4',  'o',  '-',  'm',
        'i',  'n',  'i',
        0x02, 0x00, 0x00, 0x00, // message_count = 2
        0x00, // role = 0 (system)
        0x02, 0x00, 0x00, 0x00, 'b', 'e', // text_len = 2, "be"
        0x00, 0x00, 0x00, 0x00, // tool_call_count = 0
        0x01, // role = 1 (user)
        0x02, 0x00, 0x00, 0x00, 'h', 'i', // text_len = 2, "hi"
        0x00, 0x00, 0x00, 0x00, // tool_call_count = 0
        0x01, 0x20, 0x00, 0x00, 0x00, // max_tokens_present = 1, = 32
        0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // temperature_present = 1, f64 0.0
        0x01, // stream = 1
        0x00, 0x00, 0x00, 0x00, // tool_count = 0
    };

    var req = try decodeSendRequest(&bytes, testing.allocator);
    defer req.deinit(testing.allocator);

    try testing.expectEqualStrings("gpt-4o-mini", req.model);
    try testing.expectEqual(@as(usize, 2), req.messages.len);
    try testing.expectEqual(luv.Role.system, req.messages[0].role);
    try testing.expectEqualStrings("be", req.messages[0].text);
    try testing.expectEqual(luv.Role.user, req.messages[1].role);
    try testing.expectEqualStrings("hi", req.messages[1].text);
    try testing.expectEqual(@as(?u32, 32), req.max_tokens);
    try testing.expectEqual(@as(?f64, 0.0), req.temperature);
    try testing.expectEqual(true, req.stream);
}

test "decodeSendRequest: truncated input returns error.Truncated" {
    const bytes = [_]u8{ 0x05, 0x00, 0x00, 0x00, 'h' }; // claims 5-byte model, only 1 byte present
    try testing.expectError(error.Truncated, decodeSendRequest(&bytes, testing.allocator));
}

test "encodeReply: shapes assistant Reply with end_turn into expected bytes" {
    const reply: WireReply = .{
        .message = .{ .role = .assistant, .text = "Hi" },
        .stop_reason = .end_turn,
    };
    const bytes = try encodeReply(reply, testing.allocator);
    defer testing.allocator.free(bytes);

    const expected = [_]u8{
        0x02, // role = assistant
        0x00, // stop_reason = end_turn
        0x02, 0x00, 0x00, 0x00, // text_len = 2
        'H',  'i',
        0x00, 0x00, 0x00, 0x00, // tool_call_count = 0
        0x00, // usage_present = 0
    };
    try testing.expectEqualSlices(u8, &expected, bytes);
}

test "encodeEvents: empty batch is just a zero count" {
    const bytes = try encodeEvents(&.{}, testing.allocator);
    defer testing.allocator.free(bytes);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0x00 }, bytes);
}

test "encodeEvents: start + text + stop sequence round-trips to expected bytes" {
    const events = [_]luv_stream.Event{
        .{ .start = .{ .role = .assistant } },
        .{ .text = .{ .delta = "hi" } },
        .{ .stop = .{ .stop_reason = .end_turn } },
    };
    const bytes = try encodeEvents(&events, testing.allocator);
    defer testing.allocator.free(bytes);

    const expected = [_]u8{
        // event_count = 3
        0x03, 0x00, 0x00, 0x00,
        // start { role = assistant (2) }
        0x00, 0x02,
        // text { delta_len=2, "hi" }
        0x01, 0x02,
        0x00, 0x00, 0x00, 'h',
        'i',
        // stop { stop_reason = end_turn (0) }
         0x02, 0x00,
    };
    try testing.expectEqualSlices(u8, &expected, bytes);
}

// ---------------------------------------------------------------------------
// Stream A — cross-impl conformance corpus
//
// codec_conformance.json is the single source of truth for byte parity
// between this codec and the generated TS codec. This test proves the corpus
// matches the implementation, so the TS side (A2) can assert the same bytes.

fn stopReasonFromByte(b: u8) luv.StopReason {
    return switch (b) {
        0 => .end_turn,
        1 => .max_tokens,
        2 => .content_filter,
        3 => .stop_sequence,
        4 => .tool_use,
        else => .other,
    };
}

const CorpusUsage = struct { prompt: u32, completion: u32, total: u32 };
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
const CorpusEventJson = struct {
    kind: u8,
    role: ?u8 = null,
    delta: ?[]const u8 = null,
    stopReason: ?u8 = null,
};
const CorpusEventsCase = struct {
    name: []const u8,
    events: []const CorpusEventJson,
    hex: []const u8,
};
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
    encodeEvents: []const CorpusEventsCase,
    decodeSendRequest: []const CorpusSendReqCase,
};

test "conformance corpus matches codec implementation" {
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
        const wcalls = try testing.allocator.alloc(WireToolCall, c.value.toolCalls.len);
        defer testing.allocator.free(wcalls);
        for (c.value.toolCalls, 0..) |tc, j| {
            wcalls[j] = .{
                .id = tc.id,
                .name = tc.name,
                .args = tc.args,
                .result = if (tc.result) |rr|
                    (if (rr.ok) WireToolResult{ .ok = rr.content } else WireToolResult{ .err = rr.content })
                else
                    null,
            };
        }
        const usage: ?luv.Usage = if (c.value.usage) |u|
            luv.Usage{ .prompt_tokens = u.prompt, .completion_tokens = u.completion, .total_tokens = u.total }
        else
            null;
        const reply: WireReply = .{
            .message = .{
                .role = try roleFromByte(c.value.role),
                .text = c.value.text,
                .tool_calls = wcalls,
            },
            .stop_reason = stopReasonFromByte(c.value.stopReason),
            .usage = usage,
        };
        const got = try encodeReply(reply, testing.allocator);
        defer testing.allocator.free(got);
        const exp = try std.fmt.hexToBytes(&hexbuf, c.hex);
        testing.expectEqualSlices(u8, exp, got) catch |e| {
            std.debug.print("encodeReply '{s}' mismatch\n", .{c.name});
            return e;
        };
    }

    for (corpus.encodeEvents) |c| {
        const evs = try testing.allocator.alloc(luv_stream.Event, c.events.len);
        defer testing.allocator.free(evs);
        for (c.events, 0..) |ej, i| {
            evs[i] = switch (ej.kind) {
                0 => .{ .start = .{ .role = try roleFromByte(ej.role.?) } },
                1 => .{ .text = .{ .delta = ej.delta.? } },
                2 => .{ .stop = .{ .stop_reason = stopReasonFromByte(ej.stopReason.?) } },
                else => unreachable,
            };
        }
        const got = try encodeEvents(evs, testing.allocator);
        defer testing.allocator.free(got);
        const exp = try std.fmt.hexToBytes(&hexbuf, c.hex);
        testing.expectEqualSlices(u8, exp, got) catch |e| {
            std.debug.print("encodeEvents '{s}' mismatch\n", .{c.name});
            return e;
        };
    }

    for (corpus.decodeSendRequest) |c| {
        const in = try std.fmt.hexToBytes(&hexbuf, c.hex);
        var req = try decodeSendRequest(in, testing.allocator);
        defer req.deinit(testing.allocator);
        try testing.expectEqualStrings(c.value.model, req.model);
        try testing.expectEqual(c.value.messages.len, req.messages.len);
        for (c.value.messages, 0..) |em, i| {
            const rm = req.messages[i];
            try testing.expectEqual(try roleFromByte(em.role), rm.role);
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
                } else {
                    try testing.expect(rtc.result == null);
                }
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

        // Round-trip: re-encoding the decoded value must reproduce the exact
        // corpus bytes — proves encode/decode are inverse and the corpus hex
        // is implementation-faithful (not hand-derived drift).
        const re = try encodeSendRequest(req, testing.allocator);
        defer testing.allocator.free(re);
        testing.expectEqualSlices(u8, in, re) catch |e| {
            std.debug.print("encodeSendRequest round-trip '{s}' mismatch\n", .{c.name});
            return e;
        };
    }
}
