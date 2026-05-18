//! Pure port of lib/js/src/tool_args.ts — runtime validation of a tool
//! call's parsed JSON `arguments` against a JSON-Schema-ish shape.
//!
//! Both the value and the schema are `std.json.Value` (the same shape
//! `std.json` produces from a wire payload). Validation is pure: no I/O,
//! no allocation beyond the formatted error message.
//!
//! Behavioral mirror of the TS `parseArguments` / `validate` / `ToolArgsError`:
//!   - no schema             → arguments returned untouched (no check)
//!   - `const`               → strict equality with the literal
//!   - `enum`                → membership in the literal array
//!   - type: string/number/integer/boolean/null/array/object
//!   - array `items`         → each element validated, path `[i]`
//!   - object `required`     → each key must be present, else throw
//!   - object `properties`   → present keys recursed, path `.key`
//!   - unknown/absent type   → accept anything
//!   - error path: ``<root>`` when empty, `a.b`, `a[2]` segments

const std = @import("std");
const luv = @import("luv.zig");

pub const Value = std.json.Value;

/// Mirrors the TS `ToolArgsError`. `path` is the dotted/indexed JSON path
/// to the failing node; `message` is the human-readable cause. `full` is
/// the rendered `luv-js: parseArguments failed at <path>: <message>`
/// string (arena/allocator-owned — see `validate`).
pub const ToolArgsError = struct {
    path: []const u8,
    message: []const u8,
    full: []const u8,
};

pub const Error = error{ ToolArgs, OutOfMemory };

/// Validate `call.arguments` against `schema`. On success returns the
/// arguments value unchanged (identity, like the TS function).
///
/// When `schema` is `null`, no check is performed (the no-schema TS
/// overload). On mismatch returns `error.ToolArgs` and writes the
/// populated `ToolArgsError` into `err_out`. Any strings placed in
/// `err_out` are allocated with `alloc` (caller owns; an arena is ideal).
pub fn parseArguments(
    call: luv.ToolCall,
    schema: ?Value,
    alloc: std.mem.Allocator,
    err_out: *ToolArgsError,
) Error!Value {
    const s = schema orelse return call.arguments;
    try validate(call.arguments, s, "", alloc, err_out);
    return call.arguments;
}

/// Like `parseArguments` but operating directly on a value rather than a
/// `ToolCall` (handy for tests / nested reuse).
pub fn validate(
    value: Value,
    schema: Value,
    path: []const u8,
    alloc: std.mem.Allocator,
    err_out: *ToolArgsError,
) Error!void {
    // `typeof schema !== "object" || schema === null` → no constraint.
    const s = switch (schema) {
        .object => |o| o,
        else => return,
    };

    // const
    if (s.get("const")) |c| {
        if (!jsonEql(value, c)) {
            return fail(alloc, err_out, path, "expected const {f}, got {f}", .{
                std.json.fmt(c, .{}),
                std.json.fmt(value, .{}),
            });
        }
        return;
    }

    // enum
    if (s.get("enum")) |e| {
        if (e == .array) {
            var found = false;
            for (e.array.items) |cand| {
                if (jsonEql(value, cand)) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                return fail(alloc, err_out, path, "value {f} not in enum {f}", .{
                    std.json.fmt(value, .{}),
                    std.json.fmt(e, .{}),
                });
            }
            return;
        }
    }

    const type_str: ?[]const u8 = blk: {
        const t = s.get("type") orelse break :blk null;
        break :blk switch (t) {
            .string => |str| str,
            else => null,
        };
    };

    const ts = type_str orelse return; // unknown/absent type — accept anything

    if (std.mem.eql(u8, ts, "string")) {
        if (value != .string)
            return fail(alloc, err_out, path, "expected string, got {s}", .{typeOf(value)});
        return;
    }
    if (std.mem.eql(u8, ts, "number")) {
        if (!isNumber(value))
            return fail(alloc, err_out, path, "expected number, got {s}", .{typeOf(value)});
        return;
    }
    if (std.mem.eql(u8, ts, "integer")) {
        if (!isInteger(value))
            return fail(alloc, err_out, path, "expected integer, got {s}", .{typeOf(value)});
        return;
    }
    if (std.mem.eql(u8, ts, "boolean")) {
        if (value != .bool)
            return fail(alloc, err_out, path, "expected boolean, got {s}", .{typeOf(value)});
        return;
    }
    if (std.mem.eql(u8, ts, "null")) {
        if (value != .null)
            return fail(alloc, err_out, path, "expected null, got {s}", .{typeOf(value)});
        return;
    }
    if (std.mem.eql(u8, ts, "array")) {
        if (value != .array)
            return fail(alloc, err_out, path, "expected array, got {s}", .{typeOf(value)});
        if (s.get("items")) |items| {
            for (value.array.items, 0..) |item, i| {
                const sub_path = try std.fmt.allocPrint(alloc, "{s}[{d}]", .{ path, i });
                try validate(item, items, sub_path, alloc, err_out);
            }
        }
        return;
    }
    if (std.mem.eql(u8, ts, "object")) {
        if (value != .object)
            return fail(alloc, err_out, path, "expected object, got {s}", .{typeOf(value)});
        const obj = value.object;

        // required: only honored when it is an array (mirrors TS guard).
        if (s.get("required")) |req| {
            if (req == .array) {
                for (req.array.items) |rk| {
                    if (rk != .string) continue;
                    if (obj.get(rk.string) == null) {
                        return fail(alloc, err_out, path, "missing required field \"{s}\"", .{rk.string});
                    }
                }
            }
        }

        // properties: only honored when it is an object (mirrors TS guard).
        if (s.get("properties")) |props| {
            if (props == .object) {
                var it = props.object.iterator();
                while (it.next()) |entry| {
                    const key = entry.key_ptr.*;
                    if (obj.get(key)) |sub_val| {
                        const sub_path = if (path.len == 0)
                            try alloc.dupe(u8, key)
                        else
                            try std.fmt.allocPrint(alloc, "{s}.{s}", .{ path, key });
                        try validate(sub_val, entry.value_ptr.*, sub_path, alloc, err_out);
                    }
                }
            }
        }
        return;
    }

    // default: unknown type literal — accept anything.
    return;
}

fn fail(
    alloc: std.mem.Allocator,
    err_out: *ToolArgsError,
    path: []const u8,
    comptime fmt: []const u8,
    args: anytype,
) Error {
    const msg = try std.fmt.allocPrint(alloc, fmt, args);
    const shown_path = if (path.len == 0) "<root>" else path;
    const full = try std.fmt.allocPrint(
        alloc,
        "luv-js: parseArguments failed at {s}: {s}",
        .{ shown_path, msg },
    );
    err_out.* = .{ .path = path, .message = msg, .full = full };
    return error.ToolArgs;
}

/// Mirrors the TS `typeOf` helper. Note JS has a single `number` type;
/// std.json splits it into integer / float / number_string — all map to
/// `"number"` here.
fn typeOf(v: Value) []const u8 {
    return switch (v) {
        .null => "null",
        .array => "array",
        .object => "object",
        .string => "string",
        .bool => "boolean",
        .integer, .float, .number_string => "number",
    };
}

fn isNumber(v: Value) bool {
    return switch (v) {
        .integer, .float, .number_string => true,
        else => false,
    };
}

/// `typeof value === "number" && Number.isInteger(value)`.
/// std.json `.integer` is always whole; `.float` is an integer iff it has
/// no fractional part; `.number_string` is parsed and checked.
fn isInteger(v: Value) bool {
    return switch (v) {
        .integer => true,
        .float => |f| std.math.floor(f) == f and std.math.isFinite(f),
        .number_string => |ns| blk: {
            if (std.fmt.parseInt(i64, ns, 10)) |_| {
                break :blk true;
            } else |_| {
                const f = std.fmt.parseFloat(f64, ns) catch break :blk false;
                break :blk std.math.floor(f) == f and std.math.isFinite(f);
            }
        },
        else => false,
    };
}

/// JS `===` semantics over std.json.Value, restricted to the cases the TS
/// `const`/`enum` paths can hit. Numbers compare by mathematical value
/// (1 === 1.0). Objects/arrays compare by reference in JS — schema literals
/// are never object/array constants in practice, so we treat them as
/// never-equal (matches `value !== s.const` for distinct references).
fn jsonEql(a: Value, b: Value) bool {
    return switch (a) {
        .null => b == .null,
        .bool => |x| b == .bool and b.bool == x,
        .string => |x| b == .string and std.mem.eql(u8, x, b.string),
        .integer, .float, .number_string => isNumber(b) and numVal(a) == numVal(b),
        .array, .object => false, // reference equality in JS — distinct refs
    };
}

fn numVal(v: Value) f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        .number_string => |ns| std.fmt.parseFloat(f64, ns) catch std.math.nan(f64),
        else => unreachable,
    };
}

// ===========================================================================
// Tests — mirror lib/js/test/tool_args.test.ts case-for-case.

const testing = std.testing;

const Ctx = struct {
    arena: std.heap.ArenaAllocator,
    fn init() Ctx {
        return .{ .arena = std.heap.ArenaAllocator.init(testing.allocator) };
    }
    fn deinit(self: *Ctx) void {
        self.arena.deinit();
    }
    fn a(self: *Ctx) std.mem.Allocator {
        return self.arena.allocator();
    }
    fn json(self: *Ctx, src: []const u8) !Value {
        return std.json.parseFromSliceLeaky(Value, self.a(), src, .{});
    }
    fn call(self: *Ctx, args_src: []const u8) !luv.ToolCall {
        return .{ .id = "x", .name = "x", .arguments = try self.json(args_src) };
    }
};

fn expectOk(ctx: *Ctx, call: luv.ToolCall, schema_src: []const u8) !Value {
    var e: ToolArgsError = undefined;
    const schema = try ctx.json(schema_src);
    return parseArguments(call, schema, ctx.a(), &e);
}

fn expectFail(ctx: *Ctx, call: luv.ToolCall, schema_src: []const u8) !ToolArgsError {
    var e: ToolArgsError = undefined;
    const schema = try ctx.json(schema_src);
    const r = parseArguments(call, schema, ctx.a(), &e);
    try testing.expectError(error.ToolArgs, r);
    return e;
}

const weather_schema =
    \\{"type":"object","properties":{"city":{"type":"string"},
    \\"units":{"type":"string","enum":["c","f"]}},"required":["city"]}
;

test "parseArguments: returns the typed args when shape matches" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const c = try ctx.call("{\"city\":\"Tokyo\",\"units\":\"c\"}");
    const args = try expectOk(&ctx, c, weather_schema);
    try testing.expectEqualStrings("Tokyo", args.object.get("city").?.string);
    try testing.expectEqualStrings("c", args.object.get("units").?.string);
}

test "parseArguments: throws when required field is missing" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const c = try ctx.call("{\"units\":\"c\"}");
    const e = try expectFail(&ctx, c, weather_schema);
    try testing.expect(std.mem.indexOf(u8, e.message, "city") != null);
}

test "parseArguments: throws when a field has the wrong type" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const c = try ctx.call("{\"city\":42}");
    const e = try expectFail(&ctx, c, weather_schema);
    try testing.expect(std.mem.indexOf(u8, e.message, "string") != null);
    try testing.expectEqualStrings("city", e.path);
}

test "parseArguments: works without a schema (just identity return)" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const c = try ctx.call("{\"city\":\"Tokyo\"}");
    var e: ToolArgsError = undefined;
    const args = try parseArguments(c, null, ctx.a(), &e);
    try testing.expectEqualStrings("Tokyo", args.object.get("city").?.string);
}

test "parseArguments: validates nested object shape" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const nested =
        \\{"type":"object","properties":{"profile":{"type":"object",
        \\"properties":{"name":{"type":"string"}},"required":["name"]}},
        \\"required":["profile"]}
    ;
    const ok = try ctx.call("{\"profile\":{\"name\":\"Sam\"}}");
    const r = try expectOk(&ctx, ok, nested);
    try testing.expectEqualStrings("Sam", r.object.get("profile").?.object.get("name").?.string);

    const bad = try ctx.call("{\"profile\":{}}");
    const e = try expectFail(&ctx, bad, nested);
    try testing.expect(std.mem.indexOf(u8, e.message, "name") != null);
}

test "parseArguments: validates array items" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch =
        \\{"type":"object","properties":{"items":{"type":"array",
        \\"items":{"type":"string"}}},"required":["items"]}
    ;
    const ok = try ctx.call("{\"items\":[\"a\",\"b\"]}");
    const r = try expectOk(&ctx, ok, sch);
    try testing.expectEqual(@as(usize, 2), r.object.get("items").?.array.items.len);

    const bad = try ctx.call("{\"items\":[\"a\",5]}");
    _ = try expectFail(&ctx, bad, sch);
}

test "parseArguments: enum constraint is enforced" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch =
        \\{"type":"object","properties":{"mode":{"type":"string",
        \\"enum":["fast","slow"]}},"required":["mode"]}
    ;
    const ok = try ctx.call("{\"mode\":\"fast\"}");
    const r = try expectOk(&ctx, ok, sch);
    try testing.expectEqualStrings("fast", r.object.get("mode").?.string);

    const bad = try ctx.call("{\"mode\":\"auto\"}");
    const e = try expectFail(&ctx, bad, sch);
    try testing.expect(std.mem.indexOf(u8, e.message, "enum") != null or
        std.mem.indexOf(u8, e.path, "mode") != null);
}

test "parseArguments: integer type rejects floats" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch = "{\"type\":\"object\",\"properties\":{\"count\":{\"type\":\"integer\"}},\"required\":[\"count\"]}";
    const c = try ctx.call("{\"count\":1.5}");
    const e = try expectFail(&ctx, c, sch);
    try testing.expect(std.mem.indexOf(u8, e.message, "integer") != null);
}

test "parseArguments: integer accepts whole numbers" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch = "{\"type\":\"object\",\"properties\":{\"count\":{\"type\":\"integer\"}},\"required\":[\"count\"]}";
    const c = try ctx.call("{\"count\":42}");
    const r = try expectOk(&ctx, c, sch);
    try testing.expectEqual(@as(i64, 42), r.object.get("count").?.integer);
}

test "parseArguments: integer accepts whole-valued floats" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    // JS: Number.isInteger(2.0) === true (2.0 is a whole number).
    const sch = "{\"type\":\"object\",\"properties\":{\"count\":{\"type\":\"integer\"}},\"required\":[\"count\"]}";
    const c = try ctx.call("{\"count\":2.0}");
    _ = try expectOk(&ctx, c, sch);
}

test "parseArguments: number accepts both integers and floats" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch = "{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"number\"}},\"required\":[\"x\"]}";
    _ = try expectOk(&ctx, try ctx.call("{\"x\":42}"), sch);
    _ = try expectOk(&ctx, try ctx.call("{\"x\":1.5}"), sch);
}

test "parseArguments: boolean type rejects non-booleans" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch = "{\"type\":\"object\",\"properties\":{\"flag\":{\"type\":\"boolean\"}},\"required\":[\"flag\"]}";
    const c = try ctx.call("{\"flag\":\"true\"}");
    const e = try expectFail(&ctx, c, sch);
    try testing.expect(std.mem.indexOf(u8, e.message, "boolean") != null);
}

test "parseArguments: null type accepts null only" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch = "{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"null\"}},\"required\":[\"x\"]}";
    _ = try expectOk(&ctx, try ctx.call("{\"x\":null}"), sch);
    // Non-null value rejected (TS rejects `undefined` here with /null/).
    const e = try expectFail(&ctx, try ctx.call("{\"x\":1}"), sch);
    try testing.expect(std.mem.indexOf(u8, e.message, "null") != null);
}

test "parseArguments: array of objects validates each item" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch =
        \\{"type":"object","properties":{"users":{"type":"array",
        \\"items":{"type":"object","properties":{"name":{"type":"string"}},
        \\"required":["name"]}}},"required":["users"]}
    ;
    const ok = try ctx.call("{\"users\":[{\"name\":\"a\"},{\"name\":\"b\"}]}");
    const r = try expectOk(&ctx, ok, sch);
    try testing.expectEqual(@as(usize, 2), r.object.get("users").?.array.items.len);

    const bad = try ctx.call("{\"users\":[{\"name\":\"a\"},{\"age\":5}]}");
    const e = try expectFail(&ctx, bad, sch);
    try testing.expect(std.mem.indexOf(u8, e.message, "name") != null);
}

test "ToolArgsError.path identifies the failing field for nested objects" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch =
        \\{"type":"object","properties":{"profile":{"type":"object",
        \\"properties":{"name":{"type":"string"}},"required":["name"]}},
        \\"required":["profile"]}
    ;
    const c = try ctx.call("{\"profile\":{\"name\":42}}");
    const e = try expectFail(&ctx, c, sch);
    try testing.expectEqualStrings("profile.name", e.path);
}

test "ToolArgsError.path uses array index notation for failing array items" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch =
        \\{"type":"object","properties":{"items":{"type":"array",
        \\"items":{"type":"string"}}},"required":["items"]}
    ;
    const c = try ctx.call("{\"items\":[\"a\",5]}");
    const e = try expectFail(&ctx, c, sch);
    try testing.expectEqualStrings("items[1]", e.path);
}

test "parseArguments: extra properties (not in schema) are accepted" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch = "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}";
    const c = try ctx.call("{\"name\":\"Sam\",\"extra\":\"field\"}");
    const r = try expectOk(&ctx, c, sch);
    try testing.expectEqualStrings("Sam", r.object.get("name").?.string);
}

test "parseArguments: const schema enforces a single literal value" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    const sch = "{\"type\":\"object\",\"properties\":{\"kind\":{\"const\":\"request\"}},\"required\":[\"kind\"]}";
    const r = try expectOk(&ctx, try ctx.call("{\"kind\":\"request\"}"), sch);
    try testing.expectEqualStrings("request", r.object.get("kind").?.string);
    _ = try expectFail(&ctx, try ctx.call("{\"kind\":\"response\"}"), sch);
}

test "validate: non-object schema is a no-op (accepts anything)" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    var e: ToolArgsError = undefined;
    try validate(try ctx.json("\"anything\""), try ctx.json("null"), "", ctx.a(), &e);
    try validate(try ctx.json("42"), try ctx.json("true"), "", ctx.a(), &e);
}

test "validate: unknown type literal accepts anything" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    var e: ToolArgsError = undefined;
    try validate(try ctx.json("42"), try ctx.json("{\"type\":\"weird\"}"), "", ctx.a(), &e);
}

test "validate: enum compares numbers by value (1 == 1.0)" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    var e: ToolArgsError = undefined;
    try validate(try ctx.json("1"), try ctx.json("{\"enum\":[1.0,2]}"), "", ctx.a(), &e);
}

test "fail: root path renders as <root> in full message" {
    var ctx = Ctx.init();
    defer ctx.deinit();
    var e: ToolArgsError = undefined;
    const r = validate(try ctx.json("42"), try ctx.json("{\"type\":\"string\"}"), "", ctx.a(), &e);
    try testing.expectError(error.ToolArgs, r);
    try testing.expect(std.mem.indexOf(u8, e.full, "<root>") != null);
    try testing.expect(std.mem.startsWith(u8, e.full, "luv-js: parseArguments failed at <root>: "));
}
