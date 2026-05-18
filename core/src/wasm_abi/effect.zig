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
// Tests

const testing = std.testing;

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
