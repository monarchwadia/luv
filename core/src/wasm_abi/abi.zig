//! Declarative boundary descriptor — the single source of truth for the
//! wasm <-> host bridge. PURE DATA: the SDK generator (plans/generate-sdks.md)
//! reads this to emit per-language loader/bridges. Behaviour lives in
//! exports.zig (the impl) and the hand-written *_bridge.ts (being replaced by
//! generated output). Keeping the boundary in one inspectable artifact is
//! valuable on its own, even before the generator exists.

pub const AbiKind = enum {
    /// (in_ptr, in_len, out_ptr_cell, out_len_cell) -> i32
    bytes_io,
    /// luv_decoder_new()/feed(h,..)/free(h) streaming handle family
    decoder,
    /// agent_start/poll/feed_reply/feed_tools/abort/destroy machine family
    agent,
};

/// A non-zero wasm status the host bridge translates into a thrown error.
pub const ErrCase = struct {
    status: i32,
    error_class: []const u8,
    note: []const u8,
};

pub const Brick = struct {
    /// lib/js source module (also the language-agnostic SDK module name).
    module: []const u8,
    /// Public function the bridge exposes (signature preserved across the swap).
    fn_name: []const u8,
    /// Primary wasm export this function calls.
    wasm_export: []const u8,
    /// Extra exports for handle families (decoder/agent).
    aux_exports: []const []const u8 = &.{},
    abi: AbiKind,
    /// Status-code -> thrown-error mapping the generated bridge must emit.
    err_map: []const ErrCase = &.{},
    /// Declared non-mechanical carve-outs the generator can't infer (emitted
    /// from a known guard-template set or a tiny per-brick *_extras file).
    host_guards: []const []const u8 = &.{},
};

pub const bricks = [_]Brick{
    .{
        .module = "morphism",
        .fn_name = "toOpenAI",
        .wasm_export = "luv_build_request",
        .abi = .bytes_io,
        .host_guards = &.{"response_format"}, // applied in TS; Zig drops it
    },
    .{
        .module = "morphism",
        .fn_name = "fromOpenAI",
        .wasm_export = "luv_parse_reply",
        .abi = .bytes_io,
        .err_map = &.{
            .{ .status = -4, .error_class = "MorphismError", .note = "no choices" },
            .{ .status = -3, .error_class = "MorphismError", .note = "malformed response / bad tool args json" },
        },
    },
    .{
        .module = "morphism_anthropic",
        .fn_name = "toAnthropic",
        .wasm_export = "luv_build_anthropic_request",
        .abi = .bytes_io,
    },
    .{
        .module = "morphism_anthropic",
        .fn_name = "fromAnthropic",
        .wasm_export = "luv_parse_anthropic_reply",
        .abi = .bytes_io,
        .err_map = &.{
            .{ .status = -6, .error_class = "MorphismError", .note = "tool_use block missing id or name" },
            .{ .status = -3, .error_class = "MorphismError", .note = "malformed response" },
        },
        .host_guards = &.{"content_not_array"},
    },
    .{
        .module = "tool_args",
        .fn_name = "parseArguments",
        .wasm_export = "luv_validate_tool_args",
        .abi = .bytes_io,
        .err_map = &.{
            .{ .status = 1, .error_class = "ToolArgsError", .note = "schema validation failed" },
        },
        .host_guards = &.{"undefined_required_key"}, // JSON-boundary guard
    },
    .{
        .module = "errors",
        .fn_name = "classifyError",
        .wasm_export = "luv_classify_error",
        .abi = .bytes_io, // returns a fixed classification struct (no throw)
    },
    .{
        .module = "object",
        .fn_name = "extractObject",
        .wasm_export = "luv_extract_object",
        .abi = .bytes_io,
        .err_map = &.{
            .{ .status = 1, .error_class = "GenerateObjectError", .note = "non-JSON model output" },
            .{ .status = 2, .error_class = "GenerateObjectError", .note = "schema validation failed" },
        },
    },
    .{
        .module = "tool_calls",
        .fn_name = "pendingToolCalls",
        .wasm_export = "luv_pending_tool_calls",
        .abi = .bytes_io, // host applies the predicate filter post-call
    },
    .{
        .module = "tool_calls",
        .fn_name = "respondToToolCall",
        .wasm_export = "luv_respond_tool_call",
        .abi = .bytes_io,
    },
    .{
        .module = "sse_decoder",
        .fn_name = "SseDecoder", // stateful: new/feed/free
        .wasm_export = "luv_decoder_new",
        .aux_exports = &.{ "luv_decoder_feed", "luv_decoder_free" },
        .abi = .decoder,
    },
    .{
        .module = "agent",
        .fn_name = "runAgent",
        .wasm_export = "agent_start",
        .aux_exports = &.{
            "agent_poll",  "agent_feed_reply", "agent_feed_tools",
            "agent_abort", "agent_destroy",
        },
        .abi = .agent,
        .err_map = &.{
            .{ .status = -2, .error_class = "Error", .note = "machine protocol error" },
        },
    },
};

// ---------------------------------------------------------------------------
// Tests — internal consistency only (export existence is enforced when the
// generated loader links against the real wasm + by `make gen-check`).

const std = @import("std");
const testing = std.testing;

test "abi descriptor: well-formed and unique" {
    for (bricks, 0..) |b, i| {
        try testing.expect(b.module.len > 0);
        try testing.expect(b.fn_name.len > 0);
        try testing.expect(b.wasm_export.len > 0);
        for (b.aux_exports) |ax| try testing.expect(ax.len > 0);

        // (module, fn_name) pairs are unique.
        for (bricks[0..i]) |prev| {
            const same = std.mem.eql(u8, prev.module, b.module) and
                std.mem.eql(u8, prev.fn_name, b.fn_name);
            try testing.expect(!same);
        }
        // err_map status codes are non-zero and distinct within a brick.
        for (b.err_map, 0..) |e, j| {
            try testing.expect(e.status != 0);
            try testing.expect(e.error_class.len > 0);
            for (b.err_map[0..j]) |pe| try testing.expect(pe.status != e.status);
        }
    }
}
