//! P3 spike — declarative wire schema (plans/generate-sdks.md).
//!
//! One schema, two codecs: this file's schema-driven Zig encoder AND the
//! TS encoder emitted by tools/gen_wire.zig both consume `tool_args_in`.
//! The conformance gate (a real `luv_validate_tool_args` decode of the
//! schema-encoded bytes + byte-equality vs a hand reference + the unmodified
//! `tool_args` differential) proves they agree.
//!
//! Scope is deliberately one brick. The point of the spike is to prove the
//! approach end-to-end and surface the true cost of rolling the wire codec
//! (codec.zig/codec.ts + every per-brick bridge layout) onto this DSL.

const std = @import("std");

/// Field kinds present in the tool_args IN message. The full P3 rollout
/// extends this set (ints, fixed-width, nested/arrays for SendRequest); the
/// spike covers exactly what one real message needs.
pub const Kind = enum {
    /// u32 little-endian length prefix, then that many bytes.
    lp_bytes,
    /// single u8; here it is the presence flag for the next opt field.
    u8_flag,
    /// emitted iff the immediately-preceding u8_flag is non-zero;
    /// when present, encoded exactly like `lp_bytes`.
    opt_lp_bytes,
};

pub const Field = struct {
    name: []const u8,
    kind: Kind,
};

pub const Message = struct {
    name: []const u8,
    fields: []const Field,
};

/// `luv_validate_tool_args` IN — the single source of truth for this wire,
/// consumed by both the Zig encoder below and the generated TS encoder.
pub const tool_args_in = Message{
    .name = "ToolArgsIn",
    .fields = &.{
        .{ .name = "args", .kind = .lp_bytes },
        .{ .name = "schema_present", .kind = .u8_flag },
        .{ .name = "schema", .kind = .opt_lp_bytes },
    },
};

/// Schema-driven encoder for `tool_args_in`. Walks the declared fields — no
/// message-specific layout code. `schema == null` clears the present flag
/// and omits the optional field (mirrors the bridge's `hasSchema`).
pub fn encodeToolArgsIn(
    a: std.mem.Allocator,
    args: []const u8,
    schema: ?[]const u8,
) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(a);
    inline for (tool_args_in.fields) |f| {
        switch (f.kind) {
            .lp_bytes => try writeLp(a, &buf, args),
            .u8_flag => try buf.append(a, if (schema != null) 1 else 0),
            .opt_lp_bytes => if (schema) |s| try writeLp(a, &buf, s),
        }
    }
    return buf.toOwnedSlice(a);
}

fn writeLp(a: std.mem.Allocator, buf: *std.ArrayList(u8), data: []const u8) !void {
    var len: [4]u8 = undefined;
    std.mem.writeInt(u32, &len, @intCast(data.len), .little);
    try buf.appendSlice(a, &len);
    try buf.appendSlice(a, data);
}

// --- conformance: schema-encoded bytes == the exact hand format that
//     exports.zig's luv_validate_tool_args already decodes (proven by its
//     own line-982 test). Cross-stack conformance is the unmodified TS
//     `tool_args` differential running these bytes through the real wasm. --

const testing = std.testing;

fn handReference(a: std.mem.Allocator, args: []const u8, schema: ?[]const u8) ![]u8 {
    var b: std.ArrayList(u8) = .empty;
    var l: [4]u8 = undefined;
    std.mem.writeInt(u32, &l, @intCast(args.len), .little);
    try b.appendSlice(a, &l);
    try b.appendSlice(a, args);
    try b.append(a, if (schema != null) 1 else 0);
    if (schema) |s| {
        std.mem.writeInt(u32, &l, @intCast(s.len), .little);
        try b.appendSlice(a, &l);
        try b.appendSlice(a, s);
    }
    return b.toOwnedSlice(a);
}

test "wire spike: schema encoder == hand reference (no-schema and schema)" {
    const a = testing.allocator;

    const e1 = try encodeToolArgsIn(a, "{\"x\":1}", null);
    defer a.free(e1);
    const r1 = try handReference(a, "{\"x\":1}", null);
    defer a.free(r1);
    try testing.expectEqualSlices(u8, r1, e1);

    const sch = "{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"number\"}}}";
    const e2 = try encodeToolArgsIn(a, "{\"x\":1}", sch);
    defer a.free(e2);
    const r2 = try handReference(a, "{\"x\":1}", sch);
    defer a.free(r2);
    try testing.expectEqualSlices(u8, r2, e2);
}
