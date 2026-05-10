//! E2E: live OpenAI Chat Completions, non-streaming.
//! Skipped unless OPENAI_API_KEY is set in the environment.

const std = @import("std");
const luv_core = @import("luv_core");

const luv = luv_core.luv;
const requester = luv_core.requester_openai;
const http_transport = luv_core.transport_http;

test "live: OpenAI requester.send returns assistant Reply with end_turn" {
    const gpa = std.testing.allocator;

    const api_key = std.testing.environ.getAlloc(gpa, "OPENAI_API_KEY") catch |err| switch (err) {
        error.EnvironmentVariableMissing => return error.SkipZigTest,
        else => return err,
    };
    defer gpa.free(api_key);

    var client: std.http.Client = .{ .allocator = gpa, .io = std.testing.io };
    defer client.deinit();

    var http = http_transport.HttpTransport.init(&client);

    const messages = [_]luv.Message{
        .{ .role = .user, .text = "Say hello in one short sentence." },
    };

    const reply = try requester.send(http.transport(), .{ .api_key = api_key }, &messages, .{
        .model = "gpt-4o-mini",
        .max_tokens = 32,
        .temperature = 0,
    }, gpa);
    defer gpa.free(reply.message.text);

    try std.testing.expectEqual(luv.Role.assistant, reply.message.role);
    try std.testing.expect(reply.message.text.len > 0);
    try std.testing.expectEqual(luv.StopReason.end_turn, reply.stop_reason);
}
