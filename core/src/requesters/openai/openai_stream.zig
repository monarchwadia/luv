//! Streaming OpenAI requester. Composes the stream morphism with a Transport:
//! build wire JSON with stream=true, drive raw SSE bytes through the Decoder,
//! invoke the user's event handler for each emitted luv.Event.

const std = @import("std");
const luv = @import("../../morphisms/luv/luv.zig");
const luv_stream = @import("../../morphisms/luv/luv_stream.zig");
const morphism = @import("../../morphisms/openai/openai.zig");
const stream_morphism = @import("../../morphisms/openai/openai_stream.zig");
const transport_mod = @import("../../transport/transport.zig");
const requester = @import("openai.zig");

pub const Transport = transport_mod.Transport;
pub const Header = transport_mod.Header;
pub const Config = requester.Config;
pub const Event = luv_stream.Event;

pub const EventHandler = struct {
    ctx: *anyopaque,
    on_event: *const fn (ctx: *anyopaque, event: Event) anyerror!void,
};

pub const StreamError = error{
    BadStatus,
    HandlerFailed,
    MalformedStream,
} || transport_mod.Error;

/// Send a conversation with `stream=true` and dispatch each decoded Event to
/// `handler`. Returns when the upstream signals `data: [DONE]` (or the SSE
/// body completes).
pub fn sendStream(
    transport: Transport,
    config: Config,
    conversation: luv.Conversation,
    opts: morphism.Options,
    handler: EventHandler,
    alloc: std.mem.Allocator,
) StreamError!u16 {
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var stream_opts = opts;
    stream_opts.stream = true;

    const body_bytes = requester.buildRequestBytes(conversation, stream_opts, arena) catch return error.OutOfMemory;
    const url = std.fmt.allocPrint(arena, "{s}/v1/chat/completions", .{config.base_url}) catch return error.OutOfMemory;
    const auth = std.fmt.allocPrint(arena, "Bearer {s}", .{config.api_key}) catch return error.OutOfMemory;

    const headers = [_]Header{
        .{ .name = "Authorization", .value = auth },
        .{ .name = "Content-Type", .value = "application/json" },
        .{ .name = "Accept", .value = "text/event-stream" },
    };

    var bridge = Bridge{
        .alloc = alloc,
        .decoder = .init(alloc),
        .handler = handler,
        .first_error = null,
    };
    defer bridge.decoder.deinit();

    const status = transport.sendStream(.{
        .url = url,
        .method = .POST,
        .headers = &headers,
        .body = body_bytes,
    }, .{ .ctx = &bridge, .on_chunk = Bridge.onChunk }) catch |err| switch (err) {
        error.HandlerFailed => return bridge.first_error orelse error.HandlerFailed,
        else => |e| return e,
    };

    if (status != 200) return error.BadStatus;
    return status;
}

const Bridge = struct {
    alloc: std.mem.Allocator,
    decoder: stream_morphism.Decoder,
    handler: EventHandler,
    first_error: ?StreamError,

    fn onChunk(ctx: *anyopaque, chunk: []const u8) anyerror!void {
        const self: *Bridge = @ptrCast(@alignCast(ctx));
        const events = self.decoder.feed(chunk) catch {
            self.first_error = error.MalformedStream;
            return error.DecoderFailed;
        };
        for (events) |e| {
            self.handler.on_event(self.handler.ctx, e) catch |err| {
                self.first_error = error.HandlerFailed;
                return err;
            };
        }
    }
};

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

const Collector = struct {
    alloc: std.mem.Allocator,
    text: std.ArrayList(u8) = .empty,
    saw_start: bool = false,
    saw_stop: bool = false,
    stop_reason: ?luv.StopReason = null,

    fn deinit(self: *Collector) void {
        self.text.deinit(self.alloc);
    }

    fn onEvent(ctx: *anyopaque, event: Event) anyerror!void {
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

test "sendStream: 011 round-trip via MockTransport collects start + deltas + stop" {
    const canned = try loadFixture("fixtures/openai/011_stream_basic/response.sse.txt");
    defer testing.allocator.free(canned);

    var transport = mock.MockTransport.init(testing.allocator, canned);
    defer transport.deinit();

    var collector = Collector{ .alloc = testing.allocator };
    defer collector.deinit();

    const messages = [_]luv.Message{
        .{ .role = .user, .text = "Count from one to five, separated by commas." },
    };

    const status = try sendStream(transport.transport(), .{ .api_key = "sk-test" }, &messages, .{
        .model = "gpt-4o-mini",
        .max_tokens = 32,
        .temperature = 0,
    }, .{ .ctx = &collector, .on_event = Collector.onEvent }, testing.allocator);

    try testing.expectEqual(@as(u16, 200), status);
    try testing.expect(collector.saw_start);
    try testing.expect(collector.saw_stop);
    try testing.expectEqual(luv.StopReason.end_turn, collector.stop_reason.?);
    try testing.expectEqualStrings("1, 2, 3, 4, 5", collector.text.items);
}

test "sendStream: outgoing request has stream=true and correct Accept header" {
    const canned = try loadFixture("fixtures/openai/011_stream_basic/response.sse.txt");
    defer testing.allocator.free(canned);

    var transport = mock.MockTransport.init(testing.allocator, canned);
    defer transport.deinit();

    var collector = Collector{ .alloc = testing.allocator };
    defer collector.deinit();

    const messages = [_]luv.Message{.{ .role = .user, .text = "x" }};
    _ = try sendStream(transport.transport(), .{ .api_key = "sk-test" }, &messages, .{
        .model = "gpt-4o-mini",
    }, .{ .ctx = &collector, .on_event = Collector.onEvent }, testing.allocator);

    const last = transport.last orelse return error.TestFailed;
    try testing.expectEqualStrings("text/event-stream", last.header("Accept") orelse "");
    try testing.expect(std.mem.indexOf(u8, last.body, "\"stream\":true") != null);
}
