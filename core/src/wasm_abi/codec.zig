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

pub const SendRequestInput = struct {
    model: []const u8,
    messages: []const luv.Message,
    max_tokens: ?u32,
    temperature: ?f32,
    stream: bool,

    pub fn deinit(self: *SendRequestInput, alloc: std.mem.Allocator) void {
        for (self.messages) |m| alloc.free(m.text);
        alloc.free(self.messages);
        alloc.free(self.model);
        self.* = undefined;
    }
};

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

    fn readF32(self: *Reader) DecodeError!f32 {
        try self.need(4);
        const v = @as(f32, @bitCast(std.mem.readInt(u32, self.bytes[self.pos..][0..4], .little)));
        self.pos += 4;
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
    var r: Reader = .{ .bytes = bytes };

    const model_len = try r.readU32();
    const model = try r.readSliceDup(model_len, alloc);
    errdefer alloc.free(model);

    const message_count = try r.readU32();
    const messages = try alloc.alloc(luv.Message, message_count);
    errdefer alloc.free(messages);
    var initialized: usize = 0;
    errdefer for (messages[0..initialized]) |m| alloc.free(m.text);

    var i: usize = 0;
    while (i < message_count) : (i += 1) {
        const role_byte = try r.readU8();
        const role = try roleFromByte(role_byte);
        const text_len = try r.readU32();
        const text = try r.readSliceDup(text_len, alloc);
        messages[i] = .{ .role = role, .text = text };
        initialized = i + 1;
    }

    const max_tokens_present = try r.readU8();
    const max_tokens: ?u32 = if (max_tokens_present == 0) null else try r.readU32();

    const temperature_present = try r.readU8();
    const temperature: ?f32 = if (temperature_present == 0) null else try r.readF32();

    const stream_byte = try r.readU8();

    return .{
        .model = model,
        .messages = messages,
        .max_tokens = max_tokens,
        .temperature = temperature,
        .stream = stream_byte != 0,
    };
}

pub fn encodeReply(reply: luv.Reply, alloc: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
    const total = 1 + 1 + 4 + reply.message.text.len;
    var out = try alloc.alloc(u8, total);
    errdefer alloc.free(out);
    out[0] = roleToByte(reply.message.role);
    out[1] = stopReasonToByte(reply.stop_reason);
    std.mem.writeInt(u32, out[2..6], @intCast(reply.message.text.len), .little);
    @memcpy(out[6..], reply.message.text);
    return out;
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
        // model_len = 1
        0x01, 0x00, 0x00, 0x00,
        'm',
        // message_count = 1
         0x01, 0x00, 0x00,
        0x00,
        // role = 1 (user), text_len = 2, "hi"
        0x01, 0x02, 0x00,
        0x00, 0x00, 'h',  'i',
        // max_tokens_present = 0
        0x00,
        // temperature_present = 0
        0x00,
        // stream = 0
        0x00,
    };

    var req = try decodeSendRequest(&bytes, testing.allocator);
    defer req.deinit(testing.allocator);

    try testing.expectEqualStrings("m", req.model);
    try testing.expectEqual(@as(usize, 1), req.messages.len);
    try testing.expectEqual(luv.Role.user, req.messages[0].role);
    try testing.expectEqualStrings("hi", req.messages[0].text);
    try testing.expectEqual(@as(?u32, null), req.max_tokens);
    try testing.expectEqual(@as(?f32, null), req.temperature);
    try testing.expectEqual(false, req.stream);
}

test "decodeSendRequest: full request (model, multi-turn, max_tokens, temperature, stream)" {
    const bytes = [_]u8{
        // model_len = 11, "gpt-4o-mini"
        0x0B, 0x00, 0x00, 0x00,
        'g',  'p',  't',  '-',
        '4',  'o',  '-',  'm',
        'i',  'n',  'i',
        // message_count = 2
         0x02,
        0x00, 0x00, 0x00,
        // role=0 (system), text_len=2, "be"
        0x00,
        0x02, 0x00, 0x00, 0x00,
        'b',  'e',
        // role=1 (user), text_len=2, "hi"
         0x01, 0x02,
        0x00, 0x00, 0x00, 'h',
        'i',
        // max_tokens_present = 1, max_tokens = 32
         0x01, 0x20, 0x00,
        0x00, 0x00,
        // temperature_present = 1, temperature = 0.0 (f32)
        0x01, 0x00,
        0x00, 0x00, 0x00,
        // stream = 1
        0x01,
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
    try testing.expectEqual(@as(?f32, 0.0), req.temperature);
    try testing.expectEqual(true, req.stream);
}

test "decodeSendRequest: truncated input returns error.Truncated" {
    const bytes = [_]u8{ 0x05, 0x00, 0x00, 0x00, 'h' }; // claims 5-byte model, only 1 byte present
    try testing.expectError(error.Truncated, decodeSendRequest(&bytes, testing.allocator));
}

test "encodeReply: shapes assistant Reply with end_turn into expected bytes" {
    const reply: luv.Reply = .{
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
