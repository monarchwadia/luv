//! Streaming variant of luv: lifecycle events emitted as a turn unfolds.
//!
//! Provider stream morphisms decode their wire format into a sequence of these
//! events. Folding a complete event stream yields the equivalent non-streaming
//! `luv.Reply` (text concatenation + final stop_reason). Pure data; no methods.

const std = @import("std");
const luv = @import("luv.zig");

pub const Event = union(enum) {
    start: Start,
    text: Text,
    stop: Stop,

    pub const Start = struct { role: luv.Role };
    pub const Text = struct { delta: []const u8 };
    pub const Stop = struct { stop_reason: luv.StopReason };
};

test "Event tags carry their payloads" {
    const e_start: Event = .{ .start = .{ .role = .assistant } };
    try std.testing.expectEqual(luv.Role.assistant, e_start.start.role);

    const e_text: Event = .{ .text = .{ .delta = "hi" } };
    try std.testing.expectEqualStrings("hi", e_text.text.delta);

    const e_stop: Event = .{ .stop = .{ .stop_reason = .end_turn } };
    try std.testing.expectEqual(luv.StopReason.end_turn, e_stop.stop.stop_reason);
}

test "Event union switch is exhaustive" {
    const events = [_]Event{
        .{ .start = .{ .role = .assistant } },
        .{ .text = .{ .delta = "a" } },
        .{ .text = .{ .delta = "b" } },
        .{ .stop = .{ .stop_reason = .end_turn } },
    };
    var text_count: usize = 0;
    var saw_start: bool = false;
    var saw_stop: bool = false;
    for (events) |e| switch (e) {
        .start => saw_start = true,
        .text => text_count += 1,
        .stop => saw_stop = true,
    };
    try std.testing.expect(saw_start);
    try std.testing.expectEqual(@as(usize, 2), text_count);
    try std.testing.expect(saw_stop);
}
