//! E2E: live OpenAI Chat Completions, streaming.
//! Skipped unless OPENAI_API_KEY is set in the environment.

const std = @import("std");
const luv_core = @import("luv_core");

const luv = luv_core.luv;
const luv_stream = luv_core.luv_stream;
const stream_requester = luv_core.requester_openai_stream;
const http_transport = luv_core.transport_http;

const Collector = struct {
    alloc: std.mem.Allocator,
    text: std.ArrayList(u8) = .empty,
    saw_start: bool = false,
    saw_stop: bool = false,
    stop_reason: ?luv.StopReason = null,

    fn deinit(self: *Collector) void {
        self.text.deinit(self.alloc);
    }

    fn onEvent(ctx: *anyopaque, event: luv_stream.Event) anyerror!void {
        const self: *Collector = @ptrCast(@alignCast(ctx));
        switch (event) {
            .start => self.saw_start = true,
            .text => |t| try self.text.appendSlice(self.alloc, t.delta),
            .stop => |s| {
                self.saw_stop = true;
                self.stop_reason = s.stop_reason;
            },
        }
    }
};

test "live: OpenAI requester.sendStream emits start + text deltas + stop" {
    const gpa = std.testing.allocator;

    const api_key = std.testing.environ.getAlloc(gpa, "OPENAI_API_KEY") catch |err| switch (err) {
        error.EnvironmentVariableMissing => return error.SkipZigTest,
        else => return err,
    };
    defer gpa.free(api_key);

    var client: std.http.Client = .{ .allocator = gpa, .io = std.testing.io };
    defer client.deinit();

    var http = http_transport.HttpTransport.init(&client);

    var collector = Collector{ .alloc = gpa };
    defer collector.deinit();

    const messages = [_]luv.Message{
        .{ .role = .user, .text = "Count from one to five, separated by commas." },
    };

    const status = try stream_requester.sendStream(http.transport(), .{ .api_key = api_key }, &messages, .{
        .model = "gpt-4o-mini",
        .max_tokens = 32,
        .temperature = 0,
    }, .{ .ctx = &collector, .on_event = Collector.onEvent }, gpa);

    try std.testing.expectEqual(@as(u16, 200), status);
    try std.testing.expect(collector.saw_start);
    try std.testing.expect(collector.saw_stop);
    try std.testing.expect(collector.text.items.len > 0);
    try std.testing.expectEqual(luv.StopReason.end_turn, collector.stop_reason.?);
}
