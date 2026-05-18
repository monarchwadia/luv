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
        error.MissingToolUseField => -6,
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

const tool_args = @import("../morphisms/luv/tool_args.zig");
const error_classify = @import("../morphisms/luv/error_classify.zig");
const object_extract = @import("../morphisms/luv/object_extract.zig");

fn emitStatusMsg(out_ptr_out: usize, out_len_out: usize, status: u8, msg: []const u8) i32 {
    // Wire: u8 status; if status != 0: u32 msg_len; msg bytes.
    const total: usize = if (status == 0) 1 else 5 + msg.len;
    const buf = allocator.alloc(u8, total) catch return -1;
    buf[0] = status;
    if (status != 0) {
        std.mem.writeInt(u32, buf[1..5], @intCast(msg.len), .little);
        @memcpy(buf[5..], msg);
    }
    writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(buf.ptr), @intCast(buf.len));
    return 0;
}

/// Validate tool-call arguments against a JSON schema.
/// In:  u32 args_len; args(JSON); u8 schema_present; [u32 schema_len; schema(JSON)]
/// Out: u8 status (0=ok, 1=invalid, 2=bad-input); [u32 msg_len; msg] when !=0
export fn luv_validate_tool_args(
    in_ptr: usize,
    in_len: usize,
    out_ptr_out: usize,
    out_len_out: usize,
) i32 {
    const bytes = sliceFromAbi(in_ptr, in_len);
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var pos: usize = 0;
    if (bytes.len < 4) return emitStatusMsg(out_ptr_out, out_len_out, 2, "truncated");
    const args_len = std.mem.readInt(u32, bytes[0..4], .little);
    pos = 4;
    if (pos + args_len + 1 > bytes.len) return emitStatusMsg(out_ptr_out, out_len_out, 2, "truncated");
    const args_bytes = bytes[pos .. pos + args_len];
    pos += args_len;
    const schema_present = bytes[pos];
    pos += 1;
    var schema: ?std.json.Value = null;
    if (schema_present != 0) {
        if (pos + 4 > bytes.len) return emitStatusMsg(out_ptr_out, out_len_out, 2, "truncated");
        const slen = std.mem.readInt(u32, bytes[pos..][0..4], .little);
        pos += 4;
        if (pos + slen > bytes.len) return emitStatusMsg(out_ptr_out, out_len_out, 2, "truncated");
        schema = std.json.parseFromSliceLeaky(std.json.Value, a, bytes[pos .. pos + slen], .{}) catch
            return emitStatusMsg(out_ptr_out, out_len_out, 2, "bad schema json");
    }
    const args_val = std.json.parseFromSliceLeaky(std.json.Value, a, args_bytes, .{}) catch
        return emitStatusMsg(out_ptr_out, out_len_out, 2, "bad args json");

    var err: tool_args.ToolArgsError = undefined;
    _ = tool_args.parseArguments(.{ .id = "", .name = "", .arguments = args_val }, schema, a, &err) catch |e| switch (e) {
        error.OutOfMemory => return -1,
        error.ToolArgs => return emitStatusMsg(out_ptr_out, out_len_out, 1, err.full),
    };
    return emitStatusMsg(out_ptr_out, out_len_out, 0, "");
}

/// Classify an HTTP error.
/// In:  u32 status; u32 body_len; body; u8 ra_present; [u32 ra_len; ra]; i64 now_ms
/// Out: u8 kind; u16 status; u8 retry_present; [u64 retry_after_ms]
export fn luv_classify_error(
    in_ptr: usize,
    in_len: usize,
    out_ptr_out: usize,
    out_len_out: usize,
) i32 {
    const bytes = sliceFromAbi(in_ptr, in_len);
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();

    var pos: usize = 0;
    if (bytes.len < 8) return -2;
    const http_status: u16 = @intCast(std.mem.readInt(u32, bytes[0..4], .little));
    pos = 4;
    const body_len = std.mem.readInt(u32, bytes[pos..][0..4], .little);
    pos += 4;
    if (pos + body_len + 1 > bytes.len) return -2;
    const body = bytes[pos .. pos + body_len];
    pos += body_len;
    const ra_present = bytes[pos];
    pos += 1;
    var ra: ?[]const u8 = null;
    if (ra_present != 0) {
        if (pos + 4 > bytes.len) return -2;
        const ral = std.mem.readInt(u32, bytes[pos..][0..4], .little);
        pos += 4;
        if (pos + ral > bytes.len) return -2;
        ra = bytes[pos .. pos + ral];
        pos += ral;
    }
    if (pos + 8 > bytes.len) return -2;
    const now_ms = std.mem.readInt(i64, bytes[pos..][0..8], .little);

    const c = error_classify.classifyError(arena.allocator(), http_status, body, ra, now_ms);
    const has_ra = c.retry_after_ms != null;
    const total: usize = 1 + 2 + 1 + (if (has_ra) @as(usize, 8) else 0);
    const buf = allocator.alloc(u8, total) catch return -1;
    buf[0] = @intFromEnum(c.kind);
    std.mem.writeInt(u16, buf[1..3], c.status, .little);
    buf[3] = if (has_ra) 1 else 0;
    if (c.retry_after_ms) |ms| std.mem.writeInt(u64, buf[4..12], ms, .little);
    writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(buf.ptr), @intCast(buf.len));
    return 0;
}

/// Extract + schema-validate a structured object from model text.
/// In:  u32 text_len; text; u32 schema_len; schema(JSON)
/// Out: u8 status (0=ok, 1=non-json, 2=schema-fail, 3=bad-input); [u32 msg_len; msg]
export fn luv_extract_object(
    in_ptr: usize,
    in_len: usize,
    out_ptr_out: usize,
    out_len_out: usize,
) i32 {
    const bytes = sliceFromAbi(in_ptr, in_len);
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    if (bytes.len < 4) return emitStatusMsg(out_ptr_out, out_len_out, 3, "truncated");
    const text_len = std.mem.readInt(u32, bytes[0..4], .little);
    var pos: usize = 4;
    if (pos + text_len + 4 > bytes.len) return emitStatusMsg(out_ptr_out, out_len_out, 3, "truncated");
    const text = bytes[pos .. pos + text_len];
    pos += text_len;
    const schema_len = std.mem.readInt(u32, bytes[pos..][0..4], .little);
    pos += 4;
    if (pos + schema_len > bytes.len) return emitStatusMsg(out_ptr_out, out_len_out, 3, "truncated");
    const schema = std.json.parseFromSliceLeaky(std.json.Value, a, bytes[pos .. pos + schema_len], .{}) catch
        return emitStatusMsg(out_ptr_out, out_len_out, 3, "bad schema json");

    var failure: object_extract.ValidationFailure = undefined;
    var extracted = object_extract.extractObject(a, text, schema, &failure) catch |e| switch (e) {
        error.NonJsonContent => return emitStatusMsg(out_ptr_out, out_len_out, 1, failure.message),
        error.SchemaValidationFailed => {
            const m = object_extract.formatSchemaError(a, failure) catch return -1;
            return emitStatusMsg(out_ptr_out, out_len_out, 2, m);
        },
    };
    extracted.deinit();
    return emitStatusMsg(out_ptr_out, out_len_out, 0, "");
}

const tool_calls = @import("../morphisms/luv/tool_calls.zig");

fn wireToLuvMessages(wmsgs: []const codec.WireMessage, a: std.mem.Allocator) ![]luv.Message {
    const lmsgs = try a.alloc(luv.Message, wmsgs.len);
    for (wmsgs, 0..) |wm, i| {
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
    return lmsgs;
}

fn luvToWireMessages(lmsgs: []const luv.Message, a: std.mem.Allocator) ![]codec.WireMessage {
    const wmsgs = try a.alloc(codec.WireMessage, lmsgs.len);
    for (lmsgs, 0..) |lm, i| {
        const calls = try a.alloc(codec.WireToolCall, lm.tool_calls.len);
        for (lm.tool_calls, 0..) |c, j| {
            const args = try std.json.Stringify.valueAlloc(a, c.arguments, .{});
            const res: ?codec.WireToolResult = if (c.result) |rr| switch (rr) {
                .ok => |s| codec.WireToolResult{ .ok = s },
                .err => |s| codec.WireToolResult{ .err = s },
            } else null;
            calls[j] = .{ .id = c.id, .name = c.name, .args = args, .result = res };
        }
        wmsgs[i] = .{ .role = lm.role, .text = lm.text, .tool_calls = calls };
    }
    return wmsgs;
}

/// In: conversation wire. Out: u32 count; per call u32 id_len;id; u32
/// name_len;name; u32 args_len; args(JSON).
export fn luv_pending_tool_calls(
    in_ptr: usize,
    in_len: usize,
    out_ptr_out: usize,
    out_len_out: usize,
) i32 {
    var conv = codec.decodeConversation(sliceFromAbi(in_ptr, in_len), allocator) catch return -2;
    defer conv.deinit();
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const lmsgs = wireToLuvMessages(conv.messages, a) catch return -1;
    const pending = tool_calls.pendingToolCalls(lmsgs, a) catch return -1;

    var total: usize = 4;
    var args_list = a.alloc([]const u8, pending.len) catch return -1;
    for (pending, 0..) |c, i| {
        const s = std.json.Stringify.valueAlloc(a, c.arguments, .{}) catch return -1;
        args_list[i] = s;
        total += 4 + c.id.len + 4 + c.name.len + 4 + s.len;
    }
    const buf = allocator.alloc(u8, total) catch return -1;
    var pos: usize = 0;
    std.mem.writeInt(u32, buf[0..4], @intCast(pending.len), .little);
    pos = 4;
    for (pending, 0..) |c, i| {
        inline for (.{ c.id, c.name, args_list[i] }) |field| {
            std.mem.writeInt(u32, buf[pos..][0..4], @intCast(field.len), .little);
            pos += 4;
            @memcpy(buf[pos .. pos + field.len], field);
            pos += field.len;
        }
    }
    writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(buf.ptr), @intCast(buf.len));
    return 0;
}

/// In: u32 conv_len; conv_wire; u32 call_id_len; call_id; u8 ok; u32
/// content_len; content. Out: new conversation wire.
export fn luv_respond_tool_call(
    in_ptr: usize,
    in_len: usize,
    out_ptr_out: usize,
    out_len_out: usize,
) i32 {
    const bytes = sliceFromAbi(in_ptr, in_len);
    if (bytes.len < 4) return -2;
    const conv_len = std.mem.readInt(u32, bytes[0..4], .little);
    var pos: usize = 4;
    if (pos + conv_len + 4 > bytes.len) return -2;
    const conv_bytes = bytes[pos .. pos + conv_len];
    pos += conv_len;
    const id_len = std.mem.readInt(u32, bytes[pos..][0..4], .little);
    pos += 4;
    if (pos + id_len + 1 + 4 > bytes.len) return -2;
    const call_id = bytes[pos .. pos + id_len];
    pos += id_len;
    const ok = bytes[pos];
    pos += 1;
    const content_len = std.mem.readInt(u32, bytes[pos..][0..4], .little);
    pos += 4;
    if (pos + content_len > bytes.len) return -2;
    const content = bytes[pos .. pos + content_len];

    var conv = codec.decodeConversation(conv_bytes, allocator) catch return -2;
    defer conv.deinit();
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const lmsgs = wireToLuvMessages(conv.messages, a) catch return -1;
    const result: luv.ToolResult = if (ok != 0) .{ .ok = content } else .{ .err = content };
    const new_conv = tool_calls.respondToToolCall(lmsgs, call_id, result, a) catch return -1;
    const wmsgs = luvToWireMessages(new_conv, a) catch return -1;
    const encoded = codec.encodeConversation(wmsgs, allocator) catch return -1;
    writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(encoded.ptr), @intCast(encoded.len));
    return 0;
}

// ---------------------------------------------------------------------------
// Sans-IO agent loop (Stream E.2). Handle-based: the host drives
// start -> poll -> feed_reply|feed_tools -> ... -> done over the codec
// boundary. provider_send/tool_calls are emitted effects the host performs.

const agent_machine = @import("../agent/agent_machine.zig");

const AgentHandle = struct {
    machine: agent_machine.AgentMachine,
    req: codec.SendRequestInput, // keeps decoded conversation/tools alive
    scratch: std.heap.ArenaAllocator, // luv projections + per-call temp
};

fn luvToolFromWire(wt: codec.WireTool, a: std.mem.Allocator) !luv.Tool {
    const schema = try std.json.parseFromSliceLeaky(std.json.Value, a, wt.input_schema, .{});
    return .{ .name = wt.name, .description = wt.description, .input_schema = schema };
}

/// In: u32 sendreq_len; sendreq(SendRequest wire); u32 max_iterations.
/// Returns an opaque handle (0 = failure).
export fn agent_start(in_ptr: usize, in_len: usize) usize {
    const bytes = sliceFromAbi(in_ptr, in_len);
    if (bytes.len < 4) return 0;
    const sr_len = std.mem.readInt(u32, bytes[0..4], .little);
    if (4 + sr_len + 4 > bytes.len) return 0;
    const sr = bytes[4 .. 4 + sr_len];
    const max_iter = std.mem.readInt(u32, bytes[4 + sr_len ..][0..4], .little);

    const h = allocator.create(AgentHandle) catch return 0;
    h.req = codec.decodeSendRequest(sr, allocator) catch {
        allocator.destroy(h);
        return 0;
    };
    h.scratch = std.heap.ArenaAllocator.init(allocator);
    const a = h.scratch.allocator();

    const lmsgs = wireToLuvMessages(h.req.messages, a) catch {
        h.req.deinit(allocator);
        h.scratch.deinit();
        allocator.destroy(h);
        return 0;
    };
    const ltools = a.alloc(luv.Tool, h.req.tools.len) catch {
        h.req.deinit(allocator);
        h.scratch.deinit();
        allocator.destroy(h);
        return 0;
    };
    for (h.req.tools, 0..) |wt, i| {
        ltools[i] = luvToolFromWire(wt, a) catch {
            h.req.deinit(allocator);
            h.scratch.deinit();
            allocator.destroy(h);
            return 0;
        };
    }

    h.machine = agent_machine.AgentMachine.init(allocator, .{
        .conversation = lmsgs,
        .model = h.req.model,
        .tools = ltools,
        .max_tokens = h.req.max_tokens,
        .temperature = h.req.temperature,
        .max_iterations = max_iter,
    }) catch {
        h.req.deinit(allocator);
        h.scratch.deinit();
        allocator.destroy(h);
        return 0;
    };
    return @intFromPtr(h);
}

/// Out: u8 tag (0=provider_send,1=tool_calls,2=done) then:
///   0: SendRequest wire    1: WireToolCall block    2: conv wire; u8 reason; u32 iters
export fn agent_poll(handle: usize, out_ptr_out: usize, out_len_out: usize) i32 {
    const h: *AgentHandle = @ptrFromInt(handle);
    const a = h.scratch.allocator();
    const p = h.machine.poll() catch return -2;

    switch (p) {
        .provider_send => |sp| {
            const wmsgs = luvToWireMessages(sp.conversation, a) catch return -1;
            const wtools = a.alloc(codec.WireTool, sp.tools.len) catch return -1;
            for (sp.tools, 0..) |t, i| {
                const s = std.json.Stringify.valueAlloc(a, t.input_schema, .{}) catch return -1;
                wtools[i] = .{ .name = t.name, .description = t.description, .input_schema = s };
            }
            const wire = codec.encodeSendRequest(.{
                .arena = undefined,
                .model = sp.model,
                .messages = wmsgs,
                .max_tokens = sp.max_tokens,
                .temperature = sp.temperature,
                .stream = false,
                .tools = wtools,
            }, a) catch return -1;
            const out = allocator.alloc(u8, 1 + wire.len) catch return -1;
            out[0] = 0;
            @memcpy(out[1..], wire);
            writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(out.ptr), @intCast(out.len));
            return 0;
        },
        .tool_calls => |calls| {
            const wcalls = a.alloc(codec.WireToolCall, calls.len) catch return -1;
            for (calls, 0..) |c, i| {
                const args = std.json.Stringify.valueAlloc(a, c.arguments, .{}) catch return -1;
                wcalls[i] = .{ .id = c.id, .name = c.name, .args = args, .result = null };
            }
            const conv: codec.WireMessage = .{ .role = .assistant, .text = "", .tool_calls = wcalls };
            const sz = 1 + codec.toolCallsSize(wcalls);
            const out = allocator.alloc(u8, sz) catch return -1;
            out[0] = 1;
            var pos: usize = 1;
            codec.writeToolCalls(out, &pos, conv.tool_calls);
            writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(out.ptr), @intCast(out.len));
            return 0;
        },
        .done => |res| {
            const wmsgs = luvToWireMessages(res.conversation, a) catch return -1;
            const conv_bytes = codec.encodeConversation(wmsgs, a) catch return -1;
            const out = allocator.alloc(u8, 1 + conv_bytes.len + 1 + 4) catch return -1;
            out[0] = 2;
            @memcpy(out[1 .. 1 + conv_bytes.len], conv_bytes);
            out[1 + conv_bytes.len] = @intFromEnum(res.reason);
            std.mem.writeInt(u32, out[1 + conv_bytes.len + 1 ..][0..4], res.iterations, .little);
            writeOutPtrLen(out_ptr_out, out_len_out, @intFromPtr(out.ptr), @intCast(out.len));
            return 0;
        },
    }
}

/// In: Reply wire; trailing u8 provider_failed.
export fn agent_feed_reply(handle: usize, in_ptr: usize, in_len: usize) i32 {
    const h: *AgentHandle = @ptrFromInt(handle);
    const bytes = sliceFromAbi(in_ptr, in_len);
    if (bytes.len < 1) return -2;
    const failed = bytes[bytes.len - 1] != 0;
    if (failed) {
        h.machine.feedReply(undefined, true) catch return -2;
        return 0;
    }
    const a = h.scratch.allocator();
    const wr = codec.decodeReply(bytes[0 .. bytes.len - 1], a) catch return -3;
    const calls = a.alloc(luv.ToolCall, wr.message.tool_calls.len) catch return -1;
    for (wr.message.tool_calls, 0..) |wc, i| {
        const args = std.json.parseFromSliceLeaky(std.json.Value, a, wc.args, .{}) catch return -3;
        calls[i] = .{ .id = wc.id, .name = wc.name, .arguments = args };
    }
    const reply: luv.Reply = .{
        .message = .{ .role = wr.message.role, .text = wr.message.text, .tool_calls = calls },
        .stop_reason = wr.stop_reason,
        .usage = wr.usage,
    };
    h.machine.feedReply(reply, false) catch return -2;
    return 0;
}

/// In: u32 count; per result: u8 ok; u32 content_len; content.
export fn agent_feed_tools(handle: usize, in_ptr: usize, in_len: usize) i32 {
    const h: *AgentHandle = @ptrFromInt(handle);
    const bytes = sliceFromAbi(in_ptr, in_len);
    if (bytes.len < 4) return -2;
    const a = h.scratch.allocator();
    const count = std.mem.readInt(u32, bytes[0..4], .little);
    const results = a.alloc(luv.ToolResult, count) catch return -1;
    var pos: usize = 4;
    var i: usize = 0;
    while (i < count) : (i += 1) {
        if (pos + 5 > bytes.len) return -2;
        const ok = bytes[pos] != 0;
        pos += 1;
        const clen = std.mem.readInt(u32, bytes[pos..][0..4], .little);
        pos += 4;
        if (pos + clen > bytes.len) return -2;
        const content = bytes[pos .. pos + clen];
        pos += clen;
        results[i] = if (ok) .{ .ok = content } else .{ .err = content };
    }
    h.machine.feedToolResults(results) catch return -2;
    return 0;
}

export fn agent_abort(handle: usize) void {
    const h: *AgentHandle = @ptrFromInt(handle);
    h.machine.abort();
}

export fn agent_destroy(handle: usize) void {
    const h: *AgentHandle = @ptrFromInt(handle);
    h.machine.deinit();
    h.req.deinit(allocator);
    h.scratch.deinit();
    allocator.destroy(h);
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

fn callRaw(
    f: *const fn (usize, usize, usize, usize) callconv(.c) i32,
    input: []const u8,
) struct { status: i32, out: []const u8, ptr: usize, len: usize } {
    var op: usize = 0;
    var ol: usize = 0;
    const st = f(
        @intCast(@intFromPtr(input.ptr)),
        @intCast(input.len),
        @intCast(@intFromPtr(&op)),
        @intCast(@intFromPtr(&ol)),
    );
    const native: []const u8 = if (st == 0)
        @as([*]const u8, @ptrFromInt(@as(usize, op)))[0..@as(usize, ol)]
    else
        &.{};
    return .{ .status = st, .out = native, .ptr = op, .len = ol };
}

test "luv_validate_tool_args: ok and invalid" {
    // args={"x":1}, schema={"type":"object","properties":{"x":{"type":"number"}}}
    const args = "{\"x\":1}";
    const schema = "{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"number\"}}}";
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(testing.allocator);
    try buf.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(args.len)))));
    try buf.appendSlice(testing.allocator, args);
    try buf.append(testing.allocator, 1);
    try buf.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(schema.len)))));
    try buf.appendSlice(testing.allocator, schema);
    const r = callRaw(&luv_validate_tool_args, buf.items);
    try testing.expectEqual(@as(i32, 0), r.status);
    try testing.expectEqual(@as(u8, 0), r.out[0]); // ok
    luv_free(r.ptr, r.len);

    // wrong type → invalid
    const bad = "{\"x\":\"nope\"}";
    var b2: std.ArrayList(u8) = .empty;
    defer b2.deinit(testing.allocator);
    try b2.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(bad.len)))));
    try b2.appendSlice(testing.allocator, bad);
    try b2.append(testing.allocator, 1);
    try b2.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(schema.len)))));
    try b2.appendSlice(testing.allocator, schema);
    const r2 = callRaw(&luv_validate_tool_args, b2.items);
    try testing.expectEqual(@as(u8, 1), r2.out[0]); // invalid
    luv_free(r2.ptr, r2.len);
}

test "luv_classify_error: 401 -> auth, 429 -> rate_limit" {
    // wire: u32 status, u32 body_len, u8 ra_present, i64 now_ms = 17 bytes
    var b: [17]u8 = undefined;
    std.mem.writeInt(u32, b[0..4], 401, .little);
    std.mem.writeInt(u32, b[4..8], 0, .little);
    b[8] = 0;
    std.mem.writeInt(i64, b[9..17], 0, .little);
    const r = callRaw(&luv_classify_error, &b);
    try testing.expectEqual(@as(i32, 0), r.status);
    try testing.expectEqual(@as(u8, @intFromEnum(error_classify.ErrorKind.auth)), r.out[0]);
    luv_free(r.ptr, r.len);

    std.mem.writeInt(u32, b[0..4], 429, .little);
    const r2 = callRaw(&luv_classify_error, &b);
    try testing.expectEqual(@as(u8, @intFromEnum(error_classify.ErrorKind.rate_limit)), r2.out[0]);
    luv_free(r2.ptr, r2.len);
}

test "luv_extract_object: ok and non-json" {
    const schema = "{\"type\":\"object\"}";
    const text = "{\"a\":1}";
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(testing.allocator);
    try buf.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(text.len)))));
    try buf.appendSlice(testing.allocator, text);
    try buf.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(schema.len)))));
    try buf.appendSlice(testing.allocator, schema);
    const r = callRaw(&luv_extract_object, buf.items);
    try testing.expectEqual(@as(u8, 0), r.out[0]); // ok
    luv_free(r.ptr, r.len);

    const notjson = "not json at all";
    var b2: std.ArrayList(u8) = .empty;
    defer b2.deinit(testing.allocator);
    try b2.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(notjson.len)))));
    try b2.appendSlice(testing.allocator, notjson);
    try b2.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(schema.len)))));
    try b2.appendSlice(testing.allocator, schema);
    const r2 = callRaw(&luv_extract_object, b2.items);
    try testing.expectEqual(@as(u8, 1), r2.out[0]); // non-json
    luv_free(r2.ptr, r2.len);
}

test "luv_pending_tool_calls + luv_respond_tool_call round-trip" {
    // Conversation: user, assistant w/ one pending tool call c1.
    const calls = [_]codec.WireToolCall{
        .{ .id = "c1", .name = "wx", .args = "{\"city\":\"T\"}", .result = null },
    };
    const msgs = [_]codec.WireMessage{
        .{ .role = .user, .text = "weather?", .tool_calls = &.{} },
        .{ .role = .assistant, .text = "", .tool_calls = &calls },
    };
    const conv = try codec.encodeConversation(&msgs, testing.allocator);
    defer testing.allocator.free(conv);

    // pending → exactly c1
    const p = callRaw(&luv_pending_tool_calls, conv);
    try testing.expectEqual(@as(i32, 0), p.status);
    try testing.expectEqual(@as(u32, 1), std.mem.readInt(u32, p.out[0..4], .little));
    const id_len = std.mem.readInt(u32, p.out[4..8], .little);
    try testing.expectEqualStrings("c1", p.out[8 .. 8 + id_len]);
    luv_free(p.ptr, p.len);

    // respond: build [u32 conv_len; conv; u32 id_len; id; u8 ok; u32 clen; content]
    var in: std.ArrayList(u8) = .empty;
    defer in.deinit(testing.allocator);
    try in.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(conv.len)))));
    try in.appendSlice(testing.allocator, conv);
    try in.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, 2))));
    try in.appendSlice(testing.allocator, "c1");
    try in.append(testing.allocator, 1); // ok
    const content = "{\"t\":18}";
    try in.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(content.len)))));
    try in.appendSlice(testing.allocator, content);

    const rr = callRaw(&luv_respond_tool_call, in.items);
    try testing.expectEqual(@as(i32, 0), rr.status);
    const new_conv_bytes = try testing.allocator.dupe(u8, rr.out);
    defer testing.allocator.free(new_conv_bytes);
    luv_free(rr.ptr, rr.len);

    var nc = try codec.decodeConversation(new_conv_bytes, testing.allocator);
    defer nc.deinit();
    try testing.expectEqual(@as(usize, 2), nc.messages.len);
    const a_msg = nc.messages[1];
    try testing.expectEqual(@as(usize, 1), a_msg.tool_calls.len);
    try testing.expect(a_msg.tool_calls[0].result != null);
    switch (a_msg.tool_calls[0].result.?) {
        .ok => |s| try testing.expectEqualStrings("{\"t\":18}", s),
        .err => try testing.expect(false),
    }
}

test "agent_start/poll/feed_reply: single turn -> done end_turn" {
    // Build the agent_start input: u32 sr_len; SendRequest wire; u32 max_iter.
    const umsg = [_]codec.WireMessage{.{ .role = .user, .text = "hi", .tool_calls = &.{} }};
    const sr = try codec.encodeSendRequest(.{
        .arena = undefined,
        .model = "m",
        .messages = &umsg,
        .max_tokens = null,
        .temperature = null,
        .stream = false,
        .tools = &.{},
    }, testing.allocator);
    defer testing.allocator.free(sr);

    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(testing.allocator);
    try input.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, @intCast(sr.len)))));
    try input.appendSlice(testing.allocator, sr);
    try input.appendSlice(testing.allocator, &@as([4]u8, @bitCast(@as(u32, 10))));

    const handle = agent_start(@intFromPtr(input.items.ptr), input.items.len);
    try testing.expect(handle != 0);
    defer agent_destroy(handle);

    // poll #1 -> provider_send (tag 0)
    var op: usize = 0;
    var ol: usize = 0;
    try testing.expectEqual(@as(i32, 0), agent_poll(handle, @intFromPtr(&op), @intFromPtr(&ol)));
    {
        const out: []const u8 = @as([*]const u8, @ptrFromInt(op))[0..ol];
        try testing.expectEqual(@as(u8, 0), out[0]);
        luv_free(op, ol);
    }

    // feed an assistant end_turn reply (Reply wire ++ u8 not-failed)
    const reply = try codec.encodeReply(.{
        .message = .{ .role = .assistant, .text = "hello", .tool_calls = &.{} },
        .stop_reason = .end_turn,
    }, testing.allocator);
    defer testing.allocator.free(reply);
    var fr: std.ArrayList(u8) = .empty;
    defer fr.deinit(testing.allocator);
    try fr.appendSlice(testing.allocator, reply);
    try fr.append(testing.allocator, 0);
    try testing.expectEqual(@as(i32, 0), agent_feed_reply(handle, @intFromPtr(fr.items.ptr), fr.items.len));

    // poll #2 -> done (tag 2), reason end_turn (0), iterations 1
    try testing.expectEqual(@as(i32, 0), agent_poll(handle, @intFromPtr(&op), @intFromPtr(&ol)));
    {
        const out: []const u8 = @as([*]const u8, @ptrFromInt(op))[0..ol];
        try testing.expectEqual(@as(u8, 2), out[0]);
        try testing.expectEqual(@as(u8, 0), out[out.len - 5]); // reason = end_turn
        try testing.expectEqual(@as(u32, 1), std.mem.readInt(u32, out[out.len - 4 ..][0..4], .little));
        luv_free(op, ol);
    }
}
