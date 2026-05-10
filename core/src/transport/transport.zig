//! Transport interface — vtable-style abstraction over HTTP.
//!
//! Production wires this to `std.http.Client` (see `http.zig`); tests use
//! `MockTransport` (see `mock.zig`). A Transport handle is 16 bytes (one ptr +
//! one vtable ptr) and is passed by value.

const std = @import("std");

pub const Method = enum { GET, POST };

pub const Header = struct {
    name: []const u8,
    value: []const u8,
};

pub const Request = struct {
    url: []const u8,
    method: Method = .POST,
    headers: []const Header = &.{},
    body: []const u8 = &.{},
};

pub const Response = struct {
    status: u16,
    /// Body owned by the allocator passed to `send`. Caller must free.
    body: []u8,
};

/// Sink for streaming response chunks. `on_chunk` is invoked once per
/// transport-emitted byte slice; the slice is borrowed for the duration of the
/// call.
pub const StreamHandler = struct {
    ctx: *anyopaque,
    on_chunk: *const fn (ctx: *anyopaque, chunk: []const u8) anyerror!void,
};

pub const Error = error{
    ConnectionRefused,
    TlsFailure,
    Timeout,
    NetworkError,
    HandlerFailed,
    Unexpected,
} || std.mem.Allocator.Error;

pub const Transport = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        send: *const fn (ptr: *anyopaque, req: Request, alloc: std.mem.Allocator) Error!Response,
        send_stream: *const fn (ptr: *anyopaque, req: Request, handler: StreamHandler) Error!u16,
    };

    pub fn send(self: Transport, req: Request, alloc: std.mem.Allocator) Error!Response {
        return self.vtable.send(self.ptr, req, alloc);
    }

    pub fn sendStream(self: Transport, req: Request, handler: StreamHandler) Error!u16 {
        return self.vtable.send_stream(self.ptr, req, handler);
    }
};

test "Transport handle is 16 bytes (two pointers)" {
    try std.testing.expectEqual(@as(usize, @sizeOf(*anyopaque) * 2), @sizeOf(Transport));
}
