//! Production transport — wraps `std.http.Client`. Used by e2e tests.
//!
//! Owns no client; you pass one in and stay responsible for its lifetime.

const std = @import("std");
const Io = std.Io;
const transport_mod = @import("transport.zig");

pub const Transport = transport_mod.Transport;
pub const Request = transport_mod.Request;
pub const Response = transport_mod.Response;
pub const StreamHandler = transport_mod.StreamHandler;
pub const Error = transport_mod.Error;
pub const Header = transport_mod.Header;

pub const HttpTransport = struct {
    client: *std.http.Client,

    pub fn init(client: *std.http.Client) HttpTransport {
        return .{ .client = client };
    }

    pub fn transport(self: *HttpTransport) Transport {
        return .{ .ptr = self, .vtable = &vtable };
    }

    fn methodOf(m: transport_mod.Method) std.http.Method {
        return switch (m) {
            .GET => .GET,
            .POST => .POST,
        };
    }

    fn extraHeaders(arena: std.mem.Allocator, headers: []const Header) ![]std.http.Header {
        const out = try arena.alloc(std.http.Header, headers.len);
        for (headers, 0..) |h, i| out[i] = .{ .name = h.name, .value = h.value };
        return out;
    }

    fn fetchErrorToTransport(err: anyerror) Error {
        return switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            error.ConnectionRefused => error.ConnectionRefused,
            error.ConnectionTimedOut, error.NetworkUnreachable => error.Timeout,
            error.TlsInitializationFailed, error.TlsAlert, error.TlsBadRecordMac => error.TlsFailure,
            else => error.NetworkError,
        };
    }

    fn sendImpl(ptr: *anyopaque, req: Request, alloc: std.mem.Allocator) Error!Response {
        const self: *HttpTransport = @ptrCast(@alignCast(ptr));

        var arena_state = std.heap.ArenaAllocator.init(alloc);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        var body: Io.Writer.Allocating = .init(alloc);
        errdefer body.deinit();

        const extras = extraHeaders(arena, req.headers) catch return error.OutOfMemory;

        const result = self.client.fetch(.{
            .location = .{ .url = req.url },
            .method = methodOf(req.method),
            .payload = if (req.body.len == 0) null else req.body,
            .response_writer = &body.writer,
            .extra_headers = extras,
        }) catch |err| return fetchErrorToTransport(err);

        const owned = body.toOwnedSlice() catch return error.OutOfMemory;
        return .{ .status = @intFromEnum(result.status), .body = owned };
    }

    fn sendStreamImpl(ptr: *anyopaque, req: Request, handler: StreamHandler) Error!u16 {
        const self: *HttpTransport = @ptrCast(@alignCast(ptr));

        var arena_state = std.heap.ArenaAllocator.init(self.client.allocator);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        var sink = StreamingSink.init(handler);
        const extras = extraHeaders(arena, req.headers) catch return error.OutOfMemory;

        const result = self.client.fetch(.{
            .location = .{ .url = req.url },
            .method = methodOf(req.method),
            .payload = if (req.body.len == 0) null else req.body,
            .response_writer = &sink.writer,
            .extra_headers = extras,
        }) catch |err| {
            if (sink.handler_failed) return error.HandlerFailed;
            return fetchErrorToTransport(err);
        };
        if (sink.handler_failed) return error.HandlerFailed;
        return @intFromEnum(result.status);
    }

    const vtable: Transport.VTable = .{
        .send = sendImpl,
        .send_stream = sendStreamImpl,
    };
};

/// `std.Io.Writer` adapter that dispatches each pushed slice to a StreamHandler.
const StreamingSink = struct {
    handler: StreamHandler,
    writer: Io.Writer,
    handler_failed: bool,

    fn init(handler: StreamHandler) StreamingSink {
        return .{
            .handler = handler,
            .writer = .{ .buffer = &.{}, .vtable = &writer_vtable },
            .handler_failed = false,
        };
    }

    fn drain(w: *Io.Writer, data: []const []const u8, splat: usize) Io.Writer.Error!usize {
        const self: *StreamingSink = @fieldParentPtr("writer", w);
        var total: usize = 0;
        for (data[0 .. data.len - 1]) |slice| {
            self.handler.on_chunk(self.handler.ctx, slice) catch {
                self.handler_failed = true;
                return error.WriteFailed;
            };
            total += slice.len;
        }
        const last = data[data.len - 1];
        var i: usize = 0;
        while (i < splat) : (i += 1) {
            self.handler.on_chunk(self.handler.ctx, last) catch {
                self.handler_failed = true;
                return error.WriteFailed;
            };
            total += last.len;
        }
        return total;
    }

    const writer_vtable: Io.Writer.VTable = .{
        .drain = drain,
    };
};
