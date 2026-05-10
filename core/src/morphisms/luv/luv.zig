//! Canonical luv types: pure data, no methods, no I/O.
//!
//! These are the largest common subset of all provider chat APIs — a forgetful
//! quotient. Provider morphisms map between this shape and provider-specific
//! wire JSON. Ownership of any string fields is the caller's responsibility.

const std = @import("std");

pub const Role = enum { system, user, assistant };

pub const Message = struct {
    role: Role,
    text: []const u8,
};

/// A conversation is just a slice of messages — pure data.
pub const Conversation = []const Message;

pub const StopReason = enum {
    end_turn,
    max_tokens,
    content_filter,
    stop_sequence,
    tool_use,
    other,
};

pub const Reply = struct {
    message: Message,
    stop_reason: StopReason,
};

test "Message is plain data" {
    const m: Message = .{ .role = .user, .text = "hi" };
    try std.testing.expectEqual(Role.user, m.role);
    try std.testing.expectEqualStrings("hi", m.text);
}

test "Conversation is just a slice of Message" {
    const messages = [_]Message{
        .{ .role = .system, .text = "be terse" },
        .{ .role = .user, .text = "hello" },
        .{ .role = .assistant, .text = "hi" },
    };
    const conv: Conversation = &messages;
    try std.testing.expectEqual(@as(usize, 3), conv.len);
    try std.testing.expectEqual(Role.system, conv[0].role);
    try std.testing.expectEqualStrings("be terse", conv[0].text);
    try std.testing.expectEqual(Role.assistant, conv[2].role);
}

test "Reply pairs an assistant message with a stop reason" {
    const r: Reply = .{
        .message = .{ .role = .assistant, .text = "ok" },
        .stop_reason = .end_turn,
    };
    try std.testing.expectEqual(Role.assistant, r.message.role);
    try std.testing.expectEqual(StopReason.end_turn, r.stop_reason);
}
