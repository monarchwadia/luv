//! One-shot fixture recorder for OpenAI Chat Completions.
//!
//! Usage:
//!   zig run test-tools/record_openai.zig -- <request.json> <output-dir>
//!
//! Reads <request.json> and POSTs it to https://api.openai.com/v1/chat/completions
//! using OPENAI_API_KEY from the environment. Writes the response to
//! <output-dir>/response.json (non-streaming) or <output-dir>/response.sse.txt
//! (when the request has "stream": true). Output directory must already exist.

const std = @import("std");
const Io = std.Io;

const url = "https://api.openai.com/v1/chat/completions";
const max_request_bytes: usize = 1 * 1024 * 1024;
const max_response_bytes: usize = 16 * 1024 * 1024;

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const gpa = init.gpa;
    const arena = init.arena.allocator();

    var stderr_buf: [256]u8 = undefined;
    var stderr_writer = Io.File.stderr().writer(io, &stderr_buf);
    const stderr = &stderr_writer.interface;

    const args = try init.minimal.args.toSlice(arena);
    if (args.len < 3) {
        try stderr.print("usage: record_openai <request.json> <output-dir>\n", .{});
        try stderr.flush();
        std.process.exit(2);
    }
    const request_path = args[1];
    const output_dir = args[2];

    const api_key = init.environ_map.get("OPENAI_API_KEY") orelse {
        try stderr.print("error: OPENAI_API_KEY not set in environment\n", .{});
        try stderr.flush();
        std.process.exit(1);
    };

    const cwd = Io.Dir.cwd();

    const request_bytes = try cwd.readFileAlloc(io, request_path, gpa, .limited(max_request_bytes));
    defer gpa.free(request_bytes);

    const is_stream = blk: {
        const parsed = std.json.parseFromSlice(std.json.Value, gpa, request_bytes, .{}) catch |err| {
            try stderr.print("error: {s} is not valid JSON: {s}\n", .{ request_path, @errorName(err) });
            try stderr.flush();
            std.process.exit(1);
        };
        defer parsed.deinit();
        if (parsed.value != .object) break :blk false;
        const v = parsed.value.object.get("stream") orelse break :blk false;
        break :blk v == .bool and v.bool;
    };

    const auth_header = try std.fmt.allocPrint(arena, "Bearer {s}", .{api_key});

    var client: std.http.Client = .{ .allocator = gpa, .io = io };
    defer client.deinit();

    var body: Io.Writer.Allocating = .init(gpa);
    defer body.deinit();

    const result = client.fetch(.{
        .location = .{ .url = url },
        .method = .POST,
        .payload = request_bytes,
        .response_writer = &body.writer,
        .extra_headers = &.{
            .{ .name = "Authorization", .value = auth_header },
            .{ .name = "Content-Type", .value = "application/json" },
            .{ .name = "Accept", .value = if (is_stream) "text/event-stream" else "application/json" },
        },
    }) catch |err| {
        try stderr.print("error: fetch failed: {s}\n", .{@errorName(err)});
        try stderr.flush();
        std.process.exit(1);
    };

    const status = @intFromEnum(result.status);
    const body_bytes = body.writer.buffered();

    if (status >= 400) {
        try stderr.print("error: HTTP {d}\nresponse body:\n{s}\n", .{ status, body_bytes });
        try stderr.flush();
        std.process.exit(1);
    }
    if (body_bytes.len > max_response_bytes) {
        try stderr.print("error: response too large: {d} bytes\n", .{body_bytes.len});
        try stderr.flush();
        std.process.exit(1);
    }

    if (is_stream) {
        const out_path = try std.fs.path.join(arena, &.{ output_dir, "response.sse.txt" });
        try cwd.writeFile(io, .{ .sub_path = out_path, .data = body_bytes });
        try stderr.print("wrote {s} ({d} bytes, HTTP {d})\n", .{ out_path, body_bytes.len, status });
    } else {
        const parsed = std.json.parseFromSlice(std.json.Value, gpa, body_bytes, .{}) catch |err| {
            try stderr.print("error: response is not valid JSON: {s}\nbody:\n{s}\n", .{ @errorName(err), body_bytes });
            try stderr.flush();
            std.process.exit(1);
        };
        defer parsed.deinit();

        const pretty = try std.json.Stringify.valueAlloc(gpa, parsed.value, .{ .whitespace = .indent_2 });
        defer gpa.free(pretty);

        var with_newline: Io.Writer.Allocating = .init(gpa);
        defer with_newline.deinit();
        try with_newline.writer.writeAll(pretty);
        try with_newline.writer.writeByte('\n');

        const out_path = try std.fs.path.join(arena, &.{ output_dir, "response.json" });
        try cwd.writeFile(io, .{ .sub_path = out_path, .data = with_newline.writer.buffered() });
        try stderr.print("wrote {s} ({d} bytes, HTTP {d})\n", .{ out_path, with_newline.writer.buffered().len, status });
    }
    try stderr.flush();
}
