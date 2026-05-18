//! Sans-IO effect ABI (Stream C).
//!
//! The Zig core never performs I/O. It runs as a state machine: the host
//! drives it with poll() -> resume. `poll` returns either a BATCH of effects
//! (the host performs them, concurrently, and feeds back one result per
//! effect in the same order) or `done` with the final codec-encoded output.
//!
//! Effect payloads and results are codec bytes — opaque at this layer,
//! consistent with the codec boundary (no JSON in the core).
//!
//! This file defines the ABI and a trivial EchoMachine that exercises the
//! batched poll/feed protocol and its state invariants.

const std = @import("std");

pub const EffectKind = enum(u8) {
    http_request,
    http_read_chunk,
    sleep,
    tool_call,
    now,
    emit,
};

pub const Effect = struct {
    kind: EffectKind,
    /// Codec-encoded request payload. Opaque here.
    payload: []const u8,
};

/// Result of poll(): either a batch of effects to perform, or completion.
pub const Poll = union(enum) {
    /// Host performs every effect (may be concurrent) and calls feed() with
    /// exactly results.len == effects.len, same order.
    effects: []const Effect,
    /// Final codec-encoded output. Terminal.
    done: []const u8,
};

pub const MachineError = error{
    /// poll() called again while a batch is outstanding (must feed() first).
    NotResumed,
    /// feed() called with a result count != the outstanding batch size.
    BatchMismatch,
    /// feed() called with no batch outstanding.
    NothingPending,
} || std.mem.Allocator.Error;

/// Trivial machine: emits the input as a 2-effect batch, then completes with
/// the concatenation of the fed-back results. Proves the batched protocol.
pub const EchoMachine = struct {
    alloc: std.mem.Allocator,
    state: enum { ready, awaiting, finished },
    input: []u8,
    batch: []Effect,
    output: []u8,

    pub fn init(alloc: std.mem.Allocator, input: []const u8) MachineError!EchoMachine {
        return .{
            .alloc = alloc,
            .state = .ready,
            .input = try alloc.dupe(u8, input),
            .batch = &.{},
            .output = &.{},
        };
    }

    pub fn deinit(self: *EchoMachine) void {
        self.alloc.free(self.input);
        if (self.batch.len != 0) self.alloc.free(self.batch);
        if (self.output.len != 0) self.alloc.free(self.output);
        self.* = undefined;
    }

    pub fn poll(self: *EchoMachine) MachineError!Poll {
        switch (self.state) {
            .ready => {
                const half = self.input.len / 2;
                self.batch = try self.alloc.alloc(Effect, 2);
                self.batch[0] = .{ .kind = .emit, .payload = self.input[0..half] };
                self.batch[1] = .{ .kind = .emit, .payload = self.input[half..] };
                self.state = .awaiting;
                return .{ .effects = self.batch };
            },
            .awaiting => return error.NotResumed,
            .finished => return .{ .done = self.output },
        }
    }

    pub fn feed(self: *EchoMachine, results: []const []const u8) MachineError!void {
        if (self.state != .awaiting) return error.NothingPending;
        if (results.len != self.batch.len) return error.BatchMismatch;

        var total: usize = 0;
        for (results) |r| total += r.len;
        const out = try self.alloc.alloc(u8, total);
        var pos: usize = 0;
        for (results) |r| {
            @memcpy(out[pos .. pos + r.len], r);
            pos += r.len;
        }
        self.output = out;
        self.state = .finished;
    }
};

// ---------------------------------------------------------------------------
// Wire serialization for the ABI boundary (little-endian, length-prefixed).
//
// Poll:  u8 tag (0=effects, 1=done)
//   effects: u32 count; per effect: u8 kind, u32 payload_len, payload
//   done:    u32 len, bytes
// Feed:  u32 count; per result: u32 len, bytes

pub fn serializePoll(p: Poll, alloc: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
    switch (p) {
        .effects => |effs| {
            var total: usize = 1 + 4;
            for (effs) |e| total += 1 + 4 + e.payload.len;
            const out = try alloc.alloc(u8, total);
            out[0] = 0;
            std.mem.writeInt(u32, out[1..5], @intCast(effs.len), .little);
            var pos: usize = 5;
            for (effs) |e| {
                out[pos] = @intFromEnum(e.kind);
                std.mem.writeInt(u32, out[pos + 1 ..][0..4], @intCast(e.payload.len), .little);
                @memcpy(out[pos + 5 .. pos + 5 + e.payload.len], e.payload);
                pos += 5 + e.payload.len;
            }
            return out;
        },
        .done => |d| {
            const out = try alloc.alloc(u8, 1 + 4 + d.len);
            out[0] = 1;
            std.mem.writeInt(u32, out[1..5], @intCast(d.len), .little);
            @memcpy(out[5..], d);
            return out;
        },
    }
}

fn parseFeed(bytes: []const u8, alloc: std.mem.Allocator) MachineError![][]const u8 {
    if (bytes.len < 4) return error.BatchMismatch;
    const count = std.mem.readInt(u32, bytes[0..4], .little);
    const results = try alloc.alloc([]const u8, count);
    errdefer alloc.free(results);
    var pos: usize = 4;
    var i: usize = 0;
    while (i < count) : (i += 1) {
        if (pos + 4 > bytes.len) return error.BatchMismatch;
        const len = std.mem.readInt(u32, bytes[pos..][0..4], .little);
        pos += 4;
        if (pos + len > bytes.len) return error.BatchMismatch;
        results[i] = bytes[pos .. pos + len];
        pos += len;
    }
    return results;
}

// ---------------------------------------------------------------------------
// Freestanding wasm exports (echo machine — Stream C2 round-trip target).
// Reuses exports.zig's luv_alloc/luv_free for input/output buffers.

const builtin = @import("builtin");
const eff_alloc: std.mem.Allocator = if (builtin.target.cpu.arch.isWasm())
    std.heap.wasm_allocator
else
    std.heap.page_allocator;

export fn luv_echo_start(in_ptr: usize, in_len: usize) usize {
    const input: []const u8 = if (in_len == 0)
        &.{}
    else
        @as([*]const u8, @ptrFromInt(in_ptr))[0..in_len];
    const m = eff_alloc.create(EchoMachine) catch return 0;
    m.* = EchoMachine.init(eff_alloc, input) catch {
        eff_alloc.destroy(m);
        return 0;
    };
    return @intFromPtr(m);
}

export fn luv_echo_poll(handle: usize, out_ptr_out: usize, out_len_out: usize) i32 {
    const m: *EchoMachine = @ptrFromInt(handle);
    const p = m.poll() catch return -1;
    const buf = serializePoll(p, eff_alloc) catch return -1;
    const pp: *usize = @ptrFromInt(out_ptr_out);
    const lp: *usize = @ptrFromInt(out_len_out);
    pp.* = @intFromPtr(buf.ptr);
    lp.* = buf.len;
    return 0;
}

export fn luv_echo_feed(handle: usize, res_ptr: usize, res_len: usize) i32 {
    const m: *EchoMachine = @ptrFromInt(handle);
    const bytes: []const u8 = if (res_len == 0)
        &.{}
    else
        @as([*]const u8, @ptrFromInt(res_ptr))[0..res_len];
    const results = parseFeed(bytes, eff_alloc) catch return -1;
    defer eff_alloc.free(results);
    m.feed(results) catch return -2;
    return 0;
}

export fn luv_echo_destroy(handle: usize) void {
    const m: *EchoMachine = @ptrFromInt(handle);
    m.deinit();
    eff_alloc.destroy(m);
}

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;

test "serializePoll: done frame" {
    const bytes = try serializePoll(.{ .done = "hi" }, testing.allocator);
    defer testing.allocator.free(bytes);
    try testing.expectEqualSlices(u8, &.{ 0x01, 0x02, 0x00, 0x00, 0x00, 'h', 'i' }, bytes);
}

test "EchoMachine: batched poll -> feed -> done round-trips" {
    var m = try EchoMachine.init(testing.allocator, "abcd");
    defer m.deinit();

    const p = try m.poll();
    try testing.expect(p == .effects);
    try testing.expectEqual(@as(usize, 2), p.effects.len);
    try testing.expectEqual(EffectKind.emit, p.effects[0].kind);
    try testing.expectEqualStrings("ab", p.effects[0].payload);
    try testing.expectEqualStrings("cd", p.effects[1].payload);

    try m.feed(&.{ p.effects[0].payload, p.effects[1].payload });

    const d = try m.poll();
    try testing.expect(d == .done);
    try testing.expectEqualStrings("abcd", d.done);
}

test "EchoMachine: polling an outstanding batch errors NotResumed" {
    var m = try EchoMachine.init(testing.allocator, "xy");
    defer m.deinit();
    _ = try m.poll();
    try testing.expectError(error.NotResumed, m.poll());
}

test "EchoMachine: feed with wrong result count errors BatchMismatch" {
    var m = try EchoMachine.init(testing.allocator, "xy");
    defer m.deinit();
    _ = try m.poll();
    try testing.expectError(error.BatchMismatch, m.feed(&.{"only-one"}));
}

test "EchoMachine: feed with no batch outstanding errors NothingPending" {
    var m = try EchoMachine.init(testing.allocator, "xy");
    defer m.deinit();
    try testing.expectError(error.NothingPending, m.feed(&.{}));
}
