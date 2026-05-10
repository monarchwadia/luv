//! Streaming morphism: OpenAI Chat Completions SSE → luv.Event sequence.
//!
//! Stub. Tests below intentionally fail until the implementation lands.
//!
//! Loss table (openai stream → luv stream):
//!   - id, object, created, model, system_fingerprint, service_tier — dropped on every chunk.
//!   - obfuscation — dropped (OpenAI anti-extraction noise).
//!   - choice.index, choice.logprobs — dropped.
//!   - delta.refusal — currently coerced to text (lossy: not tagged as refusal).
//!   - data: [DONE] terminator — consumed without emitting an event.

const std = @import("std");
const luv = @import("../luv/luv.zig");
const luv_stream = @import("../luv/luv_stream.zig");

pub const Event = luv_stream.Event;

pub const FeedError = error{
    InvalidUtf8,
    MalformedSse,
    MalformedJson,
    UnexpectedShape,
} || std.mem.Allocator.Error;

/// Stateful SSE → luv.Event decoder. Caller feeds raw response bytes (any
/// chunk size, including partial frames) and receives 0+ events per call.
/// Events emitted from one `feed` call are owned by the decoder until the next
/// `feed` or `deinit`; callers that need to retain text deltas must copy them.
pub const Decoder = struct {
    alloc: std.mem.Allocator,
    pending: std.ArrayList(u8),
    events: std.ArrayList(Event),
    text_buf: std.ArrayList(u8),
    saw_start: bool,
    done: bool,

    pub fn init(alloc: std.mem.Allocator) Decoder {
        return .{
            .alloc = alloc,
            .pending = .empty,
            .events = .empty,
            .text_buf = .empty,
            .saw_start = false,
            .done = false,
        };
    }

    pub fn deinit(self: *Decoder) void {
        self.pending.deinit(self.alloc);
        self.events.deinit(self.alloc);
        self.text_buf.deinit(self.alloc);
        self.* = undefined;
    }

    pub fn feed(self: *Decoder, bytes: []const u8) FeedError![]const Event {
        self.events.clearRetainingCapacity();
        self.text_buf.clearRetainingCapacity();
        try self.pending.appendSlice(self.alloc, bytes);

        var consumed: usize = 0;
        while (findFrameEnd(self.pending.items[consumed..])) |frame_len| {
            const frame = self.pending.items[consumed .. consumed + frame_len];
            consumed += frame_len;
            try self.handleFrame(stripCrLf(frame));
            if (self.done) break;
        }
        if (consumed > 0) {
            const remaining = self.pending.items.len - consumed;
            std.mem.copyForwards(u8, self.pending.items[0..remaining], self.pending.items[consumed..]);
            self.pending.shrinkRetainingCapacity(remaining);
        }

        // Resolve text-event delta pointers to text_buf storage now that the
        // buffer's final length is known and won't grow within this feed call.
        var text_off: usize = 0;
        for (self.events.items) |*e| switch (e.*) {
            .text => |*t| {
                const len = t.delta.len;
                t.delta = self.text_buf.items[text_off .. text_off + len];
                text_off += len;
            },
            else => {},
        };

        return self.events.items;
    }

    fn handleFrame(self: *Decoder, frame: []const u8) FeedError!void {
        // Each SSE frame may have multiple lines; we only care about `data:` lines.
        // Concatenate data values per the SSE spec — but Chat Completions never
        // splits a JSON across data lines, so we take the first data line.
        var data: ?[]const u8 = null;
        var line_iter = std.mem.splitScalar(u8, frame, '\n');
        while (line_iter.next()) |raw_line| {
            const line = std.mem.trimEnd(u8, raw_line, "\r");
            if (line.len == 0) continue;
            if (std.mem.startsWith(u8, line, ":")) continue; // SSE comment
            if (std.mem.startsWith(u8, line, "data:")) {
                data = std.mem.trimStart(u8, line[5..], " ");
                break;
            }
        }
        const payload = data orelse return;

        if (std.mem.eql(u8, payload, "[DONE]")) {
            self.done = true;
            return;
        }

        const parsed = std.json.parseFromSlice(std.json.Value, self.alloc, payload, .{}) catch return error.MalformedJson;
        defer parsed.deinit();
        if (parsed.value != .object) return error.UnexpectedShape;

        const choices_v = parsed.value.object.get("choices") orelse return;
        if (choices_v != .array or choices_v.array.items.len == 0) return;
        const choice = choices_v.array.items[0];
        if (choice != .object) return error.UnexpectedShape;

        if (choice.object.get("delta")) |delta_v| if (delta_v == .object) {
            if (!self.saw_start) {
                if (delta_v.object.get("role")) |role_v| if (role_v == .string and std.mem.eql(u8, role_v.string, "assistant")) {
                    try self.events.append(self.alloc, .{ .start = .{ .role = .assistant } });
                    self.saw_start = true;
                };
            }
            if (delta_v.object.get("content")) |content_v| if (content_v == .string and content_v.string.len > 0) {
                const start_off = self.text_buf.items.len;
                try self.text_buf.appendSlice(self.alloc, content_v.string);
                // Provisional pointer into a possibly-relocating buffer; resolved
                // to the final buffer storage after the feed loop completes.
                try self.events.append(self.alloc, .{ .text = .{ .delta = self.text_buf.items[start_off..self.text_buf.items.len] } });
            };
        };

        if (choice.object.get("finish_reason")) |fr_v| if (fr_v == .string) {
            const reason: luv.StopReason = if (std.mem.eql(u8, fr_v.string, "stop"))
                .end_turn
            else if (std.mem.eql(u8, fr_v.string, "length"))
                .max_tokens
            else if (std.mem.eql(u8, fr_v.string, "content_filter"))
                .content_filter
            else if (std.mem.eql(u8, fr_v.string, "tool_calls") or std.mem.eql(u8, fr_v.string, "function_call"))
                .tool_use
            else
                .other;
            try self.events.append(self.alloc, .{ .stop = .{ .stop_reason = reason } });
        };
    }
};

/// Returns the length (including the terminator) of the first complete SSE
/// frame at the start of `bytes`, or null if no full frame is present yet.
/// Frames are terminated by `\n\n` or `\r\n\r\n`.
fn findFrameEnd(bytes: []const u8) ?usize {
    if (std.mem.indexOf(u8, bytes, "\r\n\r\n")) |i| return i + 4;
    if (std.mem.indexOf(u8, bytes, "\n\n")) |i| return i + 2;
    return null;
}

/// Drop the trailing blank-line terminator from a frame slice.
fn stripCrLf(frame: []const u8) []const u8 {
    var end = frame.len;
    while (end > 0 and (frame[end - 1] == '\n' or frame[end - 1] == '\r')) end -= 1;
    return frame[0..end];
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

test "stream: 011_stream_basic decodes to start + text deltas + stop" {
    const sse = try loadFixture("fixtures/openai/011_stream_basic/response.sse.txt");
    defer testing.allocator.free(sse);

    var dec: Decoder = .init(testing.allocator);
    defer dec.deinit();

    const events = try dec.feed(sse);

    try testing.expect(events.len >= 3);
    try testing.expectEqual(@as(std.meta.Tag(Event), .start), std.meta.activeTag(events[0]));
    try testing.expectEqual(luv.Role.assistant, events[0].start.role);

    try testing.expectEqual(@as(std.meta.Tag(Event), .stop), std.meta.activeTag(events[events.len - 1]));
    try testing.expectEqual(luv.StopReason.end_turn, events[events.len - 1].stop.stop_reason);

    var concatenated: std.ArrayList(u8) = .empty;
    defer concatenated.deinit(testing.allocator);
    var text_count: usize = 0;
    for (events[1 .. events.len - 1]) |e| {
        try testing.expectEqual(@as(std.meta.Tag(Event), .text), std.meta.activeTag(e));
        try concatenated.appendSlice(testing.allocator, e.text.delta);
        text_count += 1;
    }
    try testing.expect(text_count > 0);
    try testing.expectEqualStrings("1, 2, 3, 4, 5", concatenated.items);
}

test "stream: partial-feed yields same events as one-shot feed" {
    const sse = try loadFixture("fixtures/openai/011_stream_basic/response.sse.txt");
    defer testing.allocator.free(sse);

    var one: Decoder = .init(testing.allocator);
    defer one.deinit();
    const one_shot = try one.feed(sse);
    const expected_count = one_shot.len;

    var split: Decoder = .init(testing.allocator);
    defer split.deinit();
    var collected: std.ArrayList(Event) = .empty;
    defer collected.deinit(testing.allocator);

    const chunk_size: usize = 37; // odd size — splits across SSE frame boundaries
    var i: usize = 0;
    while (i < sse.len) : (i += chunk_size) {
        const end = @min(i + chunk_size, sse.len);
        const evs = try split.feed(sse[i..end]);
        for (evs) |e| {
            const owned: Event = switch (e) {
                .text => |t| .{ .text = .{ .delta = try testing.allocator.dupe(u8, t.delta) } },
                else => e,
            };
            try collected.append(testing.allocator, owned);
        }
    }
    defer for (collected.items) |e| switch (e) {
        .text => |t| testing.allocator.free(t.delta),
        else => {},
    };

    try testing.expectEqual(expected_count, collected.items.len);
}
