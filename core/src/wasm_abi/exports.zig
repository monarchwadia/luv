//! Wasm ABI exports — the boundary the JS package talks to.
//!
//! All functions live at the wasm32-freestanding ABI: pointers are usize
//! offsets into the wasm linear memory; data is read/written via JS DataView.
//! Status codes returned: 0 = ok, < 0 = error.
//!
//! Memory ownership:
//!   - Buffers JS gives wasm (request bytes, response bytes, SSE chunks) are
//!     allocated by JS via `luv_alloc` and freed by JS via `luv_free`.
//!   - Buffers wasm gives JS (wire JSON, encoded Reply, encoded events) are
//!     allocated by wasm; JS reads them then calls `luv_free` to release.
//!
//! Status codes:
//!   0   = ok
//!   -1  = out of memory
//!   -2  = malformed input bytes (codec decode failed)
//!   -3  = malformed openai response JSON
//!   -4  = no choices in response (provider returned empty)
//!   -5  = sse decode error in stream feed

const std = @import("std");
const builtin = @import("builtin");

const luv = @import("../morphisms/luv/luv.zig");
const luv_stream = @import("../morphisms/luv/luv_stream.zig");
const morphism = @import("../morphisms/openai/openai.zig");
const anthropic = @import("../morphisms/anthropic/anthropic.zig");
const stream_morphism = @import("../morphisms/openai/openai_stream.zig");
const codec = @import("codec.zig");

const allocator: std.mem.Allocator = if (builtin.target.cpu.arch.isWasm())
    std.heap.wasm_allocator
else
    std.heap.page_allocator;

/// Allocate `len` bytes in wasm linear memory and return the offset.
/// JS uses this to set up input buffers it'll then write into and pass back.
export fn luv_alloc(len: usize) usize {
    const buf = allocator.alloc(u8, len) catch return 0;
    return @intFromPtr(buf.ptr);
}

/// Release a buffer previously returned by `luv_alloc` or by an output
/// function below. JS must always call this after consuming an output.
export fn luv_free(ptr: usize, len: usize) void {
    if (ptr == 0 or len == 0) return;
    const slice: []u8 = @as([*]u8, @ptrFromInt(ptr))[0..len];
    allocator.free(slice);
}

fn writeOutPtrLen(out_ptr_out: usize, out_len_out: usize, ptr: usize, len: usize) void {
    const ptr_dst: *usize = @ptrFromInt(out_ptr_out);
    const len_dst: *usize = @ptrFromInt(out_len_out);
    ptr_dst.* = ptr;
    len_dst.* = len;
}

fn sliceFromAbi(in_ptr: usize, in_len: usize) []const u8 {
    if (in_len == 0) return &.{};
    return @as([*]const u8, @ptrFromInt(in_ptr))[0..in_len];
}

/// Decode the JS-supplied SendRequest, build the openai wire JSON, and
/// return its bytes via *out_ptr_out / *out_len_out. JS frees with luv_free.
export fn luv_build_request(
    in_ptr: usize,
    in_len: usize,
    out_ptr_out: usize,
    out_len_out: usize,
) i32 {
    const input_bytes = sliceFromAbi(in_ptr, in_len);

    var req = codec.decodeSendRequest(input_bytes, allocator) catch |err| return switch (err) {
        error.OutOfMemory => -1,
        else => -2,
    };
    defer req.deinit(allocator);

    const wire_json = buildWireJson(req) catch |err| return switch (err) {
        error.OutOfMemory => -1,
        else => -2,
    };

    writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(wire_json.ptr), @intCast(wire_json.len));
    return 0;
}

fn buildWireJson(req: codec.SendRequestInput) ![]u8 {
    // Convert codec WireMessage[] -> luv.Message[]. The codec keeps tool-call
    // arguments as opaque JSON bytes; JSON parsing happens here, at the
    // morphism boundary (codec boundary: no std.json in the wire codec).
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const lmsgs = try a.alloc(luv.Message, req.messages.len);
    for (req.messages, 0..) |wm, i| {
        const calls = try a.alloc(luv.ToolCall, wm.tool_calls.len);
        for (wm.tool_calls, 0..) |wc, j| {
            const parsed = try std.json.parseFromSliceLeaky(std.json.Value, a, wc.args, .{});
            const result: ?luv.ToolResult = if (wc.result) |rr| switch (rr) {
                .ok => |s| luv.ToolResult{ .ok = s },
                .err => |s| luv.ToolResult{ .err = s },
            } else null;
            calls[j] = .{ .id = wc.id, .name = wc.name, .arguments = parsed, .result = result };
        }
        lmsgs[i] = .{ .role = wm.role, .text = wm.text, .tool_calls = calls };
    }

    const ltools = try a.alloc(luv.Tool, req.tools.len);
    for (req.tools, 0..) |wt, i| {
        const schema = try std.json.parseFromSliceLeaky(std.json.Value, a, wt.input_schema, .{});
        ltools[i] = .{ .name = wt.name, .description = wt.description, .input_schema = schema };
    }

    const wire = try morphism.toOpenAI(lmsgs, .{
        .model = req.model,
        .max_tokens = req.max_tokens,
        .temperature = req.temperature,
        .stream = req.stream,
        .tools = ltools,
    }, allocator);
    defer allocator.free(wire.messages);

    return std.json.Stringify.valueAlloc(allocator, wire, .{
        .emit_null_optional_fields = false,
    });
}

/// Parse the openai wire JSON response into a luv.Reply, encode it via the
/// codec, and return bytes via *out_ptr_out / *out_len_out.
export fn luv_parse_reply(
    in_ptr: usize,
    in_len: usize,
    out_ptr_out: usize,
    out_len_out: usize,
) i32 {
    const input_bytes = sliceFromAbi(in_ptr, in_len);

    const parsed = std.json.parseFromSlice(morphism.Response, allocator, input_bytes, .{
        .ignore_unknown_fields = true,
    }) catch return -3;
    defer parsed.deinit();

    const reply = morphism.fromOpenAI(parsed.value, allocator) catch |err| return switch (err) {
        error.NoChoices => -4,
        error.OutOfMemory => -1,
        error.InvalidToolArgumentsJson => -3,
    };
    defer allocator.free(reply.message.text);

    // luv.Reply -> codec.WireReply: stringify tool-call args to opaque JSON
    // bytes at the boundary (codec stays std.json-free).
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const wcalls = a.alloc(codec.WireToolCall, reply.message.tool_calls.len) catch return -1;
    for (reply.message.tool_calls, 0..) |c, j| {
        const args = std.json.Stringify.valueAlloc(a, c.arguments, .{}) catch return -1;
        const res: ?codec.WireToolResult = if (c.result) |rr| switch (rr) {
            .ok => |s| codec.WireToolResult{ .ok = s },
            .err => |s| codec.WireToolResult{ .err = s },
        } else null;
        wcalls[j] = .{ .id = c.id, .name = c.name, .args = args, .result = res };
    }
    const wreply: codec.WireReply = .{
        .message = .{ .role = reply.message.role, .text = reply.message.text, .tool_calls = wcalls },
        .stop_reason = reply.stop_reason,
        .usage = reply.usage,
    };

    const encoded = codec.encodeReply(wreply, allocator) catch return -1;
    writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(encoded.ptr), @intCast(encoded.len));
    return 0;
}

fn buildAnthropicWireJson(req: codec.SendRequestInput) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const lmsgs = try a.alloc(luv.Message, req.messages.len);
    for (req.messages, 0..) |wm, i| {
        const calls = try a.alloc(luv.ToolCall, wm.tool_calls.len);
        for (wm.tool_calls, 0..) |wc, j| {
            const parsed = try std.json.parseFromSliceLeaky(std.json.Value, a, wc.args, .{});
            const result: ?luv.ToolResult = if (wc.result) |rr| switch (rr) {
                .ok => |s| luv.ToolResult{ .ok = s },
                .err => |s| luv.ToolResult{ .err = s },
            } else null;
            calls[j] = .{ .id = wc.id, .name = wc.name, .arguments = parsed, .result = result };
        }
        lmsgs[i] = .{ .role = wm.role, .text = wm.text, .tool_calls = calls };
    }

    const ltools = try a.alloc(luv.Tool, req.tools.len);
    for (req.tools, 0..) |wt, i| {
        const schema = try std.json.parseFromSliceLeaky(std.json.Value, a, wt.input_schema, .{});
        ltools[i] = .{ .name = wt.name, .description = wt.description, .input_schema = schema };
    }

    const wire = try anthropic.toAnthropic(lmsgs, .{
        .model = req.model,
        .max_tokens = req.max_tokens,
        .temperature = req.temperature,
        .stream = req.stream,
        .tools = ltools,
    }, allocator);

    return std.json.Stringify.valueAlloc(allocator, wire, .{
        .emit_null_optional_fields = false,
    });
}

/// Decode the JS-supplied SendRequest, build the Anthropic wire JSON.
/// Same codec contract as luv_build_request — provider-agnostic input.
export fn luv_build_anthropic_request(
    in_ptr: usize,
    in_len: usize,
    out_ptr_out: usize,
    out_len_out: usize,
) i32 {
    var req = codec.decodeSendRequest(sliceFromAbi(in_ptr, in_len), allocator) catch |err| return switch (err) {
        error.OutOfMemory => -1,
        else => -2,
    };
    defer req.deinit(allocator);

    const wire_json = buildAnthropicWireJson(req) catch |err| return switch (err) {
        error.OutOfMemory => -1,
        else => -2,
    };
    writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(wire_json.ptr), @intCast(wire_json.len));
    return 0;
}

/// Parse the Anthropic wire JSON response into a codec Reply.
export fn luv_parse_anthropic_reply(
    in_ptr: usize,
    in_len: usize,
    out_ptr_out: usize,
    out_len_out: usize,
) i32 {
    const parsed = std.json.parseFromSlice(anthropic.Response, allocator, sliceFromAbi(in_ptr, in_len), .{
        .ignore_unknown_fields = true,
    }) catch return -3;
    defer parsed.deinit();

    const reply = anthropic.fromAnthropic(parsed.value, allocator) catch |err| return switch (err) {
        error.OutOfMemory => -1,
        else => -3,
    };
    defer allocator.free(reply.message.text);

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const wcalls = a.alloc(codec.WireToolCall, reply.message.tool_calls.len) catch return -1;
    for (reply.message.tool_calls, 0..) |c, j| {
        const args = std.json.Stringify.valueAlloc(a, c.arguments, .{}) catch return -1;
        const res: ?codec.WireToolResult = if (c.result) |rr| switch (rr) {
            .ok => |s| codec.WireToolResult{ .ok = s },
            .err => |s| codec.WireToolResult{ .err = s },
        } else null;
        wcalls[j] = .{ .id = c.id, .name = c.name, .args = args, .result = res };
    }
    const wreply: codec.WireReply = .{
        .message = .{ .role = reply.message.role, .text = reply.message.text, .tool_calls = wcalls },
        .stop_reason = reply.stop_reason,
        .usage = reply.usage,
    };

    const encoded = codec.encodeReply(wreply, allocator) catch return -1;
    writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(encoded.ptr), @intCast(encoded.len));
    return 0;
}

/// Allocate a streaming Decoder. Returns its address (treat as opaque handle).
export fn luv_decoder_new() usize {
    const dec_ptr = allocator.create(stream_morphism.Decoder) catch return 0;
    dec_ptr.* = .init(allocator);
    return @intFromPtr(dec_ptr);
}

export fn luv_decoder_free(handle: usize) void {
    if (handle == 0) return;
    const dec_ptr: *stream_morphism.Decoder = @ptrFromInt(handle);
    dec_ptr.deinit();
    allocator.destroy(dec_ptr);
}

/// Feed raw SSE bytes into the decoder; emit a codec-encoded EventBatch via
/// *out_ptr_out / *out_len_out. The batch may be empty (4 zero bytes).
export fn luv_decoder_feed(
    handle: usize,
    in_ptr: usize,
    in_len: usize,
    out_ptr_out: usize,
    out_len_out: usize,
) i32 {
    if (handle == 0) return -2;
    const dec_ptr: *stream_morphism.Decoder = @ptrFromInt(handle);
    const chunk = sliceFromAbi(in_ptr, in_len);

    const events = dec_ptr.feed(chunk) catch |err| return switch (err) {
        error.OutOfMemory => -1,
        else => -5,
    };

    const encoded = codec.encodeEvents(events, allocator) catch return -1;
    writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(encoded.ptr), @intCast(encoded.len));
    return 0;
}

// ---------------------------------------------------------------------------
// Tests — exercise the export pipeline using fixtures, hermetically.

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

fn callBuildRequest(input_bytes: []const u8, alloc_for_test: std.mem.Allocator) ![]u8 {
    var out_ptr: usize = 0;
    var out_len: usize = 0;
    const status = luv_build_request(
        @intCast(@intFromPtr(input_bytes.ptr)),
        @intCast(input_bytes.len),
        @intCast(@intFromPtr(&out_ptr)),
        @intCast(@intFromPtr(&out_len)),
    );
    try testing.expectEqual(@as(i32, 0), status);
    const bytes_native: []const u8 = @as([*]const u8, @ptrFromInt(@as(usize, out_ptr)))[0..@as(usize, out_len)];
    // Copy into the test allocator so the returned buffer outlives the wasm-allocator-sourced original.
    const copy = try alloc_for_test.dupe(u8, bytes_native);
    luv_free(out_ptr, out_len);
    return copy;
}

fn callParseReply(input_bytes: []const u8, alloc_for_test: std.mem.Allocator) ![]u8 {
    var out_ptr: usize = 0;
    var out_len: usize = 0;
    const status = luv_parse_reply(
        @intCast(@intFromPtr(input_bytes.ptr)),
        @intCast(input_bytes.len),
        @intCast(@intFromPtr(&out_ptr)),
        @intCast(@intFromPtr(&out_len)),
    );
    try testing.expectEqual(@as(i32, 0), status);
    const bytes_native: []const u8 = @as([*]const u8, @ptrFromInt(@as(usize, out_ptr)))[0..@as(usize, out_len)];
    const copy = try alloc_for_test.dupe(u8, bytes_native);
    luv_free(out_ptr, out_len);
    return copy;
}

test "luv_build_request: codec input → openai wire JSON contains user message" {
    // Build codec-encoded SendRequest matching 001_single_user.
    const sample_input = [_]u8{
        0x0B, 0x00, 0x00, 0x00, // model_len = 11
        'g',  'p',  't',  '-',
        '4',  'o',  '-',  'm',
        'i',  'n',  'i',
        0x01, 0x00, 0x00, 0x00, // message_count = 1
        0x01, // role = user
        0x02, 0x00, 0x00, 0x00, 'h', 'i', // text_len = 2, "hi"
        0x00, 0x00, 0x00, 0x00, // tool_call_count = 0
        0x00, // max_tokens absent
        0x00, // temperature absent
        0x00, // stream = 0
        0x00, 0x00, 0x00, 0x00, // tool_count = 0
    };

    const wire = try callBuildRequest(&sample_input, testing.allocator);
    defer testing.allocator.free(wire);

    try testing.expect(std.mem.indexOf(u8, wire, "\"model\":\"gpt-4o-mini\"") != null);
    try testing.expect(std.mem.indexOf(u8, wire, "\"role\":\"user\"") != null);
    try testing.expect(std.mem.indexOf(u8, wire, "\"hi\"") != null);
    // No max_tokens, temperature, or stream — null fields are omitted.
    try testing.expect(std.mem.indexOf(u8, wire, "\"max_tokens\"") == null);
    try testing.expect(std.mem.indexOf(u8, wire, "\"stream\"") == null);
}

test "luv_parse_reply: 001 fixture → codec-encoded Reply with end_turn" {
    const fixture = try loadFixture("fixtures/openai/001_single_user/response.json");
    defer testing.allocator.free(fixture);

    const encoded = try callParseReply(fixture, testing.allocator);
    defer testing.allocator.free(encoded);

    try testing.expect(encoded.len >= 6);
    try testing.expectEqual(@as(u8, 2), encoded[0]); // role = assistant
    try testing.expectEqual(@as(u8, 0), encoded[1]); // stop_reason = end_turn
    const text_len = std.mem.readInt(u32, encoded[2..6], .little);
    try testing.expect(text_len > 0);
    // Reply wire now carries trailing tool_call_count (u32) + usage block
    // after the text; exact tail length depends on usage presence.
    try testing.expect(encoded.len >= 6 + text_len + 4 + 1);
}

test "luv_decoder lifecycle: feed 011 fixture → events end with stop end_turn" {
    const sse = try loadFixture("fixtures/openai/011_stream_basic/response.sse.txt");
    defer testing.allocator.free(sse);

    const handle = luv_decoder_new();
    try testing.expect(handle != 0);
    defer luv_decoder_free(handle);

    var out_ptr: usize = 0;
    var out_len: usize = 0;
    const status = luv_decoder_feed(
        handle,
        @intCast(@intFromPtr(sse.ptr)),
        @intCast(sse.len),
        @intCast(@intFromPtr(&out_ptr)),
        @intCast(@intFromPtr(&out_len)),
    );
    try testing.expectEqual(@as(i32, 0), status);

    const events_bytes: []const u8 = @as([*]const u8, @ptrFromInt(@as(usize, out_ptr)))[0..@as(usize, out_len)];
    defer luv_free(out_ptr, out_len);

    try testing.expect(events_bytes.len >= 4);
    const event_count = std.mem.readInt(u32, events_bytes[0..4], .little);
    try testing.expect(event_count >= 3);

    // Last event is stop end_turn (kind=2, stop_reason=0).
    try testing.expectEqual(@as(u8, 2), events_bytes[events_bytes.len - 2]);
    try testing.expectEqual(@as(u8, 0), events_bytes[events_bytes.len - 1]);
}

fn callBuildAnthropic(input_bytes: []const u8, alloc_for_test: std.mem.Allocator) ![]u8 {
    var out_ptr: usize = 0;
    var out_len: usize = 0;
    const status = luv_build_anthropic_request(
        @intCast(@intFromPtr(input_bytes.ptr)),
        @intCast(input_bytes.len),
        @intCast(@intFromPtr(&out_ptr)),
        @intCast(@intFromPtr(&out_len)),
    );
    try testing.expectEqual(@as(i32, 0), status);
    const native: []const u8 = @as([*]const u8, @ptrFromInt(@as(usize, out_ptr)))[0..@as(usize, out_len)];
    const copy = try alloc_for_test.dupe(u8, native);
    luv_free(out_ptr, out_len);
    return copy;
}

test "luv_build_anthropic_request: codec input → anthropic wire JSON" {
    // model="m", 1 user message "hi", no opts, no tools (new codec wire:
    // per-message tool_call_count, then mt/temp present flags, stream,
    // tool_count).
    const input = [_]u8{
        0x01, 0x00, 0x00, 0x00, 'm', // model_len=1
        0x01, 0x00, 0x00, 0x00, // message_count=1
        0x01, // role=user
        0x02, 0x00, 0x00, 0x00, 'h', 'i', // text_len=2
        0x00, 0x00, 0x00, 0x00, // tool_call_count=0
        0x00, // max_tokens_present=0
        0x00, // temperature_present=0
        0x00, // stream=0
        0x00, 0x00, 0x00, 0x00, // tool_count=0
    };
    const wire = try callBuildAnthropic(&input, testing.allocator);
    defer testing.allocator.free(wire);
    try testing.expect(std.mem.indexOf(u8, wire, "\"model\":\"m\"") != null);
    try testing.expect(std.mem.indexOf(u8, wire, "\"max_tokens\":") != null); // anthropic requires it
    try testing.expect(std.mem.indexOf(u8, wire, "\"hi\"") != null);
}

test "luv_parse_anthropic_reply: minimal response → codec Reply (assistant/end_turn)" {
    const resp =
        \\{"content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":2}}
    ;
    var out_ptr: usize = 0;
    var out_len: usize = 0;
    const status = luv_parse_anthropic_reply(
        @intCast(@intFromPtr(resp.ptr)),
        @intCast(resp.len),
        @intCast(@intFromPtr(&out_ptr)),
        @intCast(@intFromPtr(&out_len)),
    );
    try testing.expectEqual(@as(i32, 0), status);
    const enc: []const u8 = @as([*]const u8, @ptrFromInt(@as(usize, out_ptr)))[0..@as(usize, out_len)];
    defer luv_free(out_ptr, out_len);
    try testing.expect(enc.len >= 6);
    try testing.expectEqual(@as(u8, 2), enc[0]); // role=assistant
    try testing.expectEqual(@as(u8, 0), enc[1]); // stop_reason=end_turn
}
