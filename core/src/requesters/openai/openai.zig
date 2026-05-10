//! Non-streaming OpenAI requester. Composes the openai morphism with a
//! Transport: build wire JSON, send via transport, parse response, return Reply.

const std = @import("std");
const luv = @import("../../morphisms/luv/luv.zig");
const morphism = @import("../../morphisms/openai/openai.zig");
const transport_mod = @import("../../transport/transport.zig");

pub const Transport = transport_mod.Transport;
pub const Header = transport_mod.Header;

pub const Config = struct {
    api_key: []const u8,
    base_url: []const u8 = "https://api.openai.com",
};

pub const SendError = error{
    BadStatus,
    EmptyResponse,
    MalformedResponse,
} || transport_mod.Error;

/// Build wire-format JSON bytes for the request. Caller frees.
pub fn buildRequestBytes(
    conversation: luv.Conversation,
    opts: morphism.Options,
    alloc: std.mem.Allocator,
) ![]u8 {
    const req_struct = try morphism.toOpenAI(conversation, opts, alloc);
    defer alloc.free(req_struct.messages);
    return std.json.Stringify.valueAlloc(alloc, req_struct, .{
        .emit_null_optional_fields = false,
    });
}

/// Parse a wire-format response body into a luv.Reply. Caller owns reply.message.text.
pub fn parseResponseBytes(bytes: []const u8, alloc: std.mem.Allocator) !luv.Reply {
    const parsed = try std.json.parseFromSlice(morphism.Response, alloc, bytes, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    return morphism.fromOpenAI(parsed.value, alloc);
}

/// Send a conversation and return the parsed Reply. Caller owns reply.message.text.
pub fn send(
    transport: Transport,
    config: Config,
    conversation: luv.Conversation,
    opts: morphism.Options,
    alloc: std.mem.Allocator,
) SendError!luv.Reply {
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const body_bytes = buildRequestBytes(conversation, opts, arena) catch return error.OutOfMemory;
    const url = std.fmt.allocPrint(arena, "{s}/v1/chat/completions", .{config.base_url}) catch return error.OutOfMemory;
    const auth = std.fmt.allocPrint(arena, "Bearer {s}", .{config.api_key}) catch return error.OutOfMemory;

    const headers = [_]Header{
        .{ .name = "Authorization", .value = auth },
        .{ .name = "Content-Type", .value = "application/json" },
    };

    const resp = try transport.send(.{
        .url = url,
        .method = .POST,
        .headers = &headers,
        .body = body_bytes,
    }, alloc);
    defer alloc.free(resp.body);

    if (resp.status != 200) return error.BadStatus;
    if (resp.body.len == 0) return error.EmptyResponse;

    return parseResponseBytes(resp.body, alloc) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        else => error.MalformedResponse,
    };
}

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;
const mock = @import("../../transport/mock.zig");

const max_fixture_bytes: usize = 1 * 1024 * 1024;

fn loadFixture(rel_path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(
        testing.io,
        rel_path,
        testing.allocator,
        .limited(max_fixture_bytes),
    );
}

test "send: 001 round-trip via MockTransport produces assistant Reply" {
    const canned = try loadFixture("fixtures/openai/001_single_user/response.json");
    defer testing.allocator.free(canned);

    var transport = mock.MockTransport.init(testing.allocator, canned);
    defer transport.deinit();

    const messages = [_]luv.Message{
        .{ .role = .user, .text = "Say hello in one short sentence." },
    };

    const reply = try send(transport.transport(), .{ .api_key = "sk-test" }, &messages, .{
        .model = "gpt-4o-mini",
        .max_tokens = 32,
        .temperature = 0,
    }, testing.allocator);
    defer testing.allocator.free(reply.message.text);

    try testing.expectEqual(luv.Role.assistant, reply.message.role);
    try testing.expect(reply.message.text.len > 0);
    try testing.expectEqual(luv.StopReason.end_turn, reply.stop_reason);
}

test "send: forwards Authorization header and POSTs to /v1/chat/completions" {
    const canned = try loadFixture("fixtures/openai/001_single_user/response.json");
    defer testing.allocator.free(canned);

    var transport = mock.MockTransport.init(testing.allocator, canned);
    defer transport.deinit();

    const messages = [_]luv.Message{.{ .role = .user, .text = "hi" }};
    const reply = try send(transport.transport(), .{ .api_key = "sk-test-key" }, &messages, .{
        .model = "gpt-4o-mini",
        .max_tokens = 16,
    }, testing.allocator);
    defer testing.allocator.free(reply.message.text);

    const last = transport.last orelse return error.TestFailed;
    try testing.expectEqualStrings("https://api.openai.com/v1/chat/completions", last.url);
    try testing.expectEqual(transport_mod.Method.POST, last.method);
    try testing.expectEqualStrings("Bearer sk-test-key", last.header("Authorization") orelse "");
    try testing.expectEqualStrings("application/json", last.header("Content-Type") orelse "");
    // body is well-formed JSON containing the user message
    try testing.expect(std.mem.indexOf(u8, last.body, "\"role\":\"user\"") != null);
    try testing.expect(std.mem.indexOf(u8, last.body, "\"hi\"") != null);
}

test "send: non-200 status surfaces as error.BadStatus" {
    var transport = mock.MockTransport.init(testing.allocator, "{\"error\":\"unauthorized\"}");
    defer transport.deinit();
    transport.canned_status = 401;

    const messages = [_]luv.Message{.{ .role = .user, .text = "hi" }};
    const result = send(transport.transport(), .{ .api_key = "sk-bad" }, &messages, .{
        .model = "gpt-4o-mini",
    }, testing.allocator);
    try testing.expectError(error.BadStatus, result);
}

test "buildRequestBytes: emits valid JSON without null optional fields" {
    const messages = [_]luv.Message{
        .{ .role = .user, .text = "Say hello in one short sentence." },
    };
    const bytes = try buildRequestBytes(&messages, .{
        .model = "gpt-4o-mini",
        .max_tokens = 32,
        .temperature = 0,
    }, testing.allocator);
    defer testing.allocator.free(bytes);

    // Should not contain "stream":null since stream is unset
    try testing.expect(std.mem.indexOf(u8, bytes, "\"stream\"") == null);
    try testing.expect(std.mem.indexOf(u8, bytes, "\"max_tokens\":32") != null);
}
