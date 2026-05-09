const std = @import("std");

pub const Role = enum { system, user, assistant };

pub const Message = struct {
    role: Role,
    text: []const u8,
};

pub const Conversation = struct {
    allocator: std.mem.Allocator,
    messages: std.ArrayList(Message),

    pub fn init(allocator: std.mem.Allocator) Conversation {
        return .{
            .allocator = allocator,
            .messages = .empty,
        };
    }

    pub fn deinit(self: *Conversation) void {
        for (self.messages.items) |m| self.allocator.free(m.text);
        self.messages.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn append(self: *Conversation, role: Role, text: []const u8) !void {
        const owned = try self.allocator.dupe(u8, text);
        errdefer self.allocator.free(owned);
        try self.messages.append(self.allocator, .{ .role = role, .text = owned });
    }

    pub fn slice(self: *const Conversation) []const Message {
        return self.messages.items;
    }
};

test "append owns text and deinit frees" {
    var conv = Conversation.init(std.testing.allocator);
    defer conv.deinit();

    var buf = [_]u8{ 'h', 'i' };
    try conv.append(.user, &buf);
    buf[0] = 'X';

    const items = conv.slice();
    try std.testing.expectEqual(@as(usize, 1), items.len);
    try std.testing.expectEqual(Role.user, items[0].role);
    try std.testing.expectEqualStrings("hi", items[0].text);
}

test "multi-message ordering" {
    var conv = Conversation.init(std.testing.allocator);
    defer conv.deinit();

    try conv.append(.system, "be terse");
    try conv.append(.user, "hello");
    try conv.append(.assistant, "hi");

    const items = conv.slice();
    try std.testing.expectEqual(@as(usize, 3), items.len);
    try std.testing.expectEqual(Role.system, items[0].role);
    try std.testing.expectEqual(Role.user, items[1].role);
    try std.testing.expectEqual(Role.assistant, items[2].role);
}
