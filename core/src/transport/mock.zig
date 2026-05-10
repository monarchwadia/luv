//! Test fixture transport. Returns canned bytes; records the most recent
//! request so tests can assert URL/headers/body shape.

const std = @import("std");
const transport_mod = @import("transport.zig");

pub const Transport = transport_mod.Transport;
pub const Request = transport_mod.Request;
pub const Response = transport_mod.Response;
pub const StreamHandler = transport_mod.StreamHandler;
pub const Error = transport_mod.Error;
pub const Header = transport_mod.Header;
pub const Method = transport_mod.Method;

pub const Snapshot = struct {
    url: []u8,
    method: Method,
    headers: []Header,
    body: []u8,

    pub fn deinit(self: *Snapshot, alloc: std.mem.Allocator) void {
        alloc.free(self.url);
        for (self.headers) |h| {
            alloc.free(h.name);
            alloc.free(h.value);
        }
        alloc.free(self.headers);
        alloc.free(self.body);
        self.* = undefined;
    }

    pub fn header(self: Snapshot, name: []const u8) ?[]const u8 {
        for (self.headers) |h| if (std.mem.eql(u8, h.name, name)) return h.value;
        return null;
    }
};

pub const MockTransport = struct {
    alloc: std.mem.Allocator,
    canned_body: []const u8,
    canned_status: u16 = 200,
    /// Stream chunk size for `send_stream`. Default mid-frame to exercise the
    /// decoder's partial-feed path.
    chunk_size: usize = 37,
    last: ?Snapshot = null,

    pub fn init(alloc: std.mem.Allocator, canned_body: []const u8) MockTransport {
        return .{ .alloc = alloc, .canned_body = canned_body };
    }

    pub fn deinit(self: *MockTransport) void {
        if (self.last) |*s| s.deinit(self.alloc);
        self.* = undefined;
    }

    pub fn transport(self: *MockTransport) Transport {
        return .{ .ptr = self, .vtable = &vtable };
    }

    fn captureRequest(self: *MockTransport, req: Request) !void {
        if (self.last) |*old| old.deinit(self.alloc);
        const url = try self.alloc.dupe(u8, req.url);
        errdefer self.alloc.free(url);
        const headers = try self.alloc.alloc(Header, req.headers.len);
        errdefer self.alloc.free(headers);
        var initialized: usize = 0;
        errdefer for (headers[0..initialized]) |h| {
            self.alloc.free(h.name);
            self.alloc.free(h.value);
        };
        for (req.headers, 0..) |h, i| {
            const n = try self.alloc.dupe(u8, h.name);
            errdefer self.alloc.free(n);
            const v = try self.alloc.dupe(u8, h.value);
            headers[i] = .{ .name = n, .value = v };
            initialized = i + 1;
        }
        const body = try self.alloc.dupe(u8, req.body);
        self.last = .{ .url = url, .method = req.method, .headers = headers, .body = body };
    }

    fn sendImpl(ptr: *anyopaque, req: Request, alloc: std.mem.Allocator) Error!Response {
        const self: *MockTransport = @ptrCast(@alignCast(ptr));
        self.captureRequest(req) catch return error.OutOfMemory;
        const body = alloc.dupe(u8, self.canned_body) catch return error.OutOfMemory;
        return .{ .status = self.canned_status, .body = body };
    }

    fn sendStreamImpl(ptr: *anyopaque, req: Request, handler: StreamHandler) Error!u16 {
        const self: *MockTransport = @ptrCast(@alignCast(ptr));
        self.captureRequest(req) catch return error.OutOfMemory;
        var i: usize = 0;
        while (i < self.canned_body.len) : (i += self.chunk_size) {
            const end = @min(i + self.chunk_size, self.canned_body.len);
            handler.on_chunk(handler.ctx, self.canned_body[i..end]) catch return error.HandlerFailed;
        }
        return self.canned_status;
    }

    const vtable: Transport.VTable = .{
        .send = sendImpl,
        .send_stream = sendStreamImpl,
    };
};

const testing = std.testing;

test "MockTransport.send returns canned body and captures request" {
    var mock = MockTransport.init(testing.allocator, "canned-body");
    defer mock.deinit();

    const headers = [_]Header{.{ .name = "Authorization", .value = "Bearer abc" }};
    const resp = try mock.transport().send(.{
        .url = "https://example.test/path",
        .body = "request-body",
        .headers = &headers,
    }, testing.allocator);
    defer testing.allocator.free(resp.body);

    try testing.expectEqual(@as(u16, 200), resp.status);
    try testing.expectEqualStrings("canned-body", resp.body);
    try testing.expect(mock.last != null);
    try testing.expectEqualStrings("https://example.test/path", mock.last.?.url);
    try testing.expectEqualStrings("request-body", mock.last.?.body);
    try testing.expectEqualStrings("Bearer abc", mock.last.?.header("Authorization").?);
}

test "MockTransport.sendStream chunks canned body through handler" {
    var mock = MockTransport.init(testing.allocator, "abcdefghijklmnopqrstuvwxyz");
    defer mock.deinit();
    mock.chunk_size = 7;

    var collected: std.ArrayList(u8) = .empty;
    defer collected.deinit(testing.allocator);

    const Sink = struct {
        out: *std.ArrayList(u8),
        alloc: std.mem.Allocator,
        fn onChunk(ctx: *anyopaque, chunk: []const u8) anyerror!void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            try self.out.appendSlice(self.alloc, chunk);
        }
    };
    var sink = Sink{ .out = &collected, .alloc = testing.allocator };

    const status = try mock.transport().sendStream(.{
        .url = "https://example.test/stream",
    }, .{ .ctx = &sink, .on_chunk = Sink.onChunk });

    try testing.expectEqual(@as(u16, 200), status);
    try testing.expectEqualStrings("abcdefghijklmnopqrstuvwxyz", collected.items);
}
