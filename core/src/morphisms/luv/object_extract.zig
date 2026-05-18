//! Pure structured-object extraction + validation. This is the I/O-free
//! core of lib/js/src/object.ts's `generateObject`: given the assistant's
//! reply text and a JSON Schema, parse the text into a JSON value and
//! validate it against the schema.
//!
//! What lives here (the pure boundary, mirrors object.ts):
//!   - `JSON.parse(reply.message.text)` → on failure:
//!     GenerateObjectError "model returned non-JSON content: <first 200>"
//!   - schema validation, reusing the `validate` walker from
//!     lib/js/src/tool_args.ts → on failure ToolArgsError, which object.ts
//!     re-wraps as GenerateObjectError "schema validation failed: <msg>"
//!
//! What stays out (I/O / request-shaping — already covered by the openai
//! morphism + TS send path): fetch, toOpenAI/response_format request build,
//! HTTP error classification, fromOpenAI wire decode, the
//! `reply.message.role !== "assistant"` check, and
//! `injectAdditionalProperties` (a request-schema transform).

const std = @import("std");

/// Mirrors object.ts `GenerateObjectError`. The TS class additionally
/// prefixes messages with "luv-js: generateObject: "; here the formatted
/// human message is produced separately via `formatError` so callers can
/// choose their own prefix. The error set is the pure failure taxonomy.
pub const GenerateObjectError = error{
    /// `JSON.parse(reply.message.text)` threw — non-JSON model output.
    NonJsonContent,
    /// Parsed fine but failed schema validation (TS: ToolArgsError, then
    /// re-wrapped as GenerateObjectError "schema validation failed: ...").
    SchemaValidationFailed,
};

/// Detail captured on a validation failure, mirroring ToolArgsError's
/// `path` + `message`. `path` is "" for the root (TS renders that as
/// "<root>"). Both slices are allocator-owned; free via `deinit`.
pub const ValidationFailure = struct {
    path: []const u8,
    message: []const u8,

    pub fn deinit(self: ValidationFailure, alloc: std.mem.Allocator) void {
        alloc.free(self.path);
        alloc.free(self.message);
    }
};

/// Successful extraction. `value` is owned by `arena`; deinit the arena to
/// free everything (the parsed tree + any validation scratch).
pub const Extracted = struct {
    arena: *std.heap.ArenaAllocator,
    value: std.json.Value,

    pub fn deinit(self: *Extracted) void {
        const child = self.arena.child_allocator;
        self.arena.deinit();
        child.destroy(self.arena);
    }
};

/// Pure port of object.ts lines 113–130: parse `reply_text` as JSON, then
/// validate against `schema`. On success the parsed value is returned in an
/// arena the caller owns.
///
/// On `error.NonJsonContent`, `failure_out` (if non-null) is filled with a
/// message mirroring `model returned non-JSON content: <first 200 chars>`.
/// On `error.SchemaValidationFailed`, `failure_out` is filled with the
/// ToolArgsError-equivalent path + message. `failure_out` strings are
/// allocator-owned (allocated with `alloc`); caller frees via
/// `ValidationFailure.deinit`.
pub fn extractObject(
    alloc: std.mem.Allocator,
    reply_text: []const u8,
    schema: std.json.Value,
    failure_out: ?*ValidationFailure,
) GenerateObjectError!Extracted {
    const arena = alloc.create(std.heap.ArenaAllocator) catch return error.NonJsonContent;
    arena.* = std.heap.ArenaAllocator.init(alloc);
    errdefer {
        arena.deinit();
        alloc.destroy(arena);
    }

    const value = std.json.parseFromSliceLeaky(
        std.json.Value,
        arena.allocator(),
        reply_text,
        .{},
    ) catch {
        if (failure_out) |fo| {
            // object.ts: `model returned non-JSON content: ${text.slice(0,200)}`
            const snippet = reply_text[0..@min(reply_text.len, 200)];
            const msg = std.fmt.allocPrint(
                alloc,
                "model returned non-JSON content: {s}",
                .{snippet},
            ) catch return error.NonJsonContent;
            fo.* = .{ .path = alloc.dupe(u8, "") catch "", .message = msg };
        }
        return error.NonJsonContent;
    };

    // Validate against the schema (re-using parseArguments' validator).
    validate(value, schema, "", alloc, failure_out) catch |e| switch (e) {
        error.OutOfMemory => return error.SchemaValidationFailed,
        error.Validation => return error.SchemaValidationFailed,
    };

    return .{ .arena = arena, .value = value };
}

/// Render the human-facing message exactly like object.ts would for a
/// schema-validation failure: `schema validation failed: luv-js:
/// parseArguments failed at <path|<root>>: <message>`. Caller frees.
pub fn formatSchemaError(
    alloc: std.mem.Allocator,
    failure: ValidationFailure,
) ![]u8 {
    const where = if (failure.path.len == 0) "<root>" else failure.path;
    return std.fmt.allocPrint(
        alloc,
        "schema validation failed: luv-js: parseArguments failed at {s}: {s}",
        .{ where, failure.message },
    );
}

const ValidateError = error{ Validation, OutOfMemory };

/// Direct port of the `validate` walker in lib/js/src/tool_args.ts.
/// `typeof schema !== "object"` ⇒ accept; const/enum short-circuit; then
/// the `type` switch. Unknown/absent type accepts anything.
fn validate(
    value: std.json.Value,
    schema: std.json.Value,
    path: []const u8,
    alloc: std.mem.Allocator,
    failure_out: ?*ValidationFailure,
) ValidateError!void {
    // TS: `if (typeof schema !== "object" || schema === null) return;`
    const s = switch (schema) {
        .object => |o| o,
        else => return,
    };

    // const
    if (s.get("const")) |c| {
        if (!jsonEql(value, c)) {
            const cs = try jsonStr(alloc, c);
            defer alloc.free(cs);
            const vs = try jsonStr(alloc, value);
            defer alloc.free(vs);
            return fail(alloc, failure_out, path, "expected const {s}, got {s}", .{ cs, vs });
        }
        return;
    }

    // enum
    if (s.get("enum")) |en| {
        if (en == .array) {
            var found = false;
            for (en.array.items) |cand| {
                if (jsonEql(value, cand)) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                const vs = try jsonStr(alloc, value);
                defer alloc.free(vs);
                const es = try jsonStr(alloc, en);
                defer alloc.free(es);
                return fail(alloc, failure_out, path, "value {s} not in enum {s}", .{ vs, es });
            }
            return;
        }
    }

    const ty = blk: {
        const t = s.get("type") orelse break :blk null;
        break :blk switch (t) {
            .string => |str| str,
            else => null,
        };
    };
    if (ty == null) return; // unknown / unspecified type — accept anything.
    const tname = ty.?;

    if (std.mem.eql(u8, tname, "string")) {
        if (value != .string)
            return fail(alloc, failure_out, path, "expected string, got {s}", .{typeOf(value)});
        return;
    }
    if (std.mem.eql(u8, tname, "number")) {
        if (!isNumber(value))
            return fail(alloc, failure_out, path, "expected number, got {s}", .{typeOf(value)});
        return;
    }
    if (std.mem.eql(u8, tname, "integer")) {
        if (!isInteger(value))
            return fail(alloc, failure_out, path, "expected integer, got {s}", .{typeOf(value)});
        return;
    }
    if (std.mem.eql(u8, tname, "boolean")) {
        if (value != .bool)
            return fail(alloc, failure_out, path, "expected boolean, got {s}", .{typeOf(value)});
        return;
    }
    if (std.mem.eql(u8, tname, "null")) {
        if (value != .null)
            return fail(alloc, failure_out, path, "expected null, got {s}", .{typeOf(value)});
        return;
    }
    if (std.mem.eql(u8, tname, "array")) {
        if (value != .array)
            return fail(alloc, failure_out, path, "expected array, got {s}", .{typeOf(value)});
        if (s.get("items")) |items| {
            for (value.array.items, 0..) |item, i| {
                const sub_path = try std.fmt.allocPrint(alloc, "{s}[{d}]", .{ path, i });
                defer alloc.free(sub_path);
                try validate(item, items, sub_path, alloc, failure_out);
            }
        }
        return;
    }
    if (std.mem.eql(u8, tname, "object")) {
        if (value != .object)
            return fail(alloc, failure_out, path, "expected object, got {s}", .{typeOf(value)});
        const obj = value.object;

        // required
        if (s.get("required")) |req| {
            if (req == .array) {
                for (req.array.items) |rk| {
                    if (rk != .string) continue;
                    if (obj.get(rk.string) == null) {
                        return fail(alloc, failure_out, path, "missing required field \"{s}\"", .{rk.string});
                    }
                }
            }
        }

        // properties
        if (s.get("properties")) |props| {
            if (props == .object) {
                var it = props.object.iterator();
                while (it.next()) |entry| {
                    const key = entry.key_ptr.*;
                    if (obj.get(key)) |child_val| {
                        const sub_path = if (path.len == 0)
                            try alloc.dupe(u8, key)
                        else
                            try std.fmt.allocPrint(alloc, "{s}.{s}", .{ path, key });
                        defer alloc.free(sub_path);
                        try validate(child_val, entry.value_ptr.*, sub_path, alloc, failure_out);
                    }
                }
            }
        }
        return;
    }
    // default: unknown type — accept anything.
    return;
}

fn fail(
    alloc: std.mem.Allocator,
    failure_out: ?*ValidationFailure,
    path: []const u8,
    comptime fmt: []const u8,
    args: anytype,
) ValidateError {
    if (failure_out) |fo| {
        const msg = std.fmt.allocPrint(alloc, fmt, args) catch return error.OutOfMemory;
        fo.* = .{
            .path = alloc.dupe(u8, path) catch return error.OutOfMemory,
            .message = msg,
        };
    }
    return error.Validation;
}

/// Mirrors tool_args.ts `typeOf`: null→"null", array→"array", else the JS
/// `typeof`. JSON has no `undefined`; std.json numbers/strings/bools map
/// straight across; objects → "object".
fn typeOf(v: std.json.Value) []const u8 {
    return switch (v) {
        .null => "null",
        .array => "array",
        .bool => "boolean",
        .integer, .float, .number_string => "number",
        .string => "string",
        .object => "object",
    };
}

fn isNumber(v: std.json.Value) bool {
    return switch (v) {
        .integer, .float, .number_string => true,
        else => false,
    };
}

fn isInteger(v: std.json.Value) bool {
    return switch (v) {
        .integer => true,
        .float => |f| @floor(f) == f and std.math.isFinite(f),
        .number_string => |ns| blk: {
            // A JSON literal too big for i64/f64 lands here; treat as
            // integer iff it has no '.'/'e'/'E'.
            break :blk std.mem.indexOfAny(u8, ns, ".eE") == null;
        },
        else => false,
    };
}

/// Structural JSON equality, for `const` / `enum` membership. Mirrors JS
/// `===` for the cases the validator hits (primitives + same numeric value).
fn jsonEql(a: std.json.Value, b: std.json.Value) bool {
    switch (a) {
        .null => return b == .null,
        .bool => |x| return b == .bool and b.bool == x,
        .string => |x| return b == .string and std.mem.eql(u8, b.string, x),
        .integer, .float, .number_string => {
            if (!isNumber(b)) return false;
            return numVal(a) == numVal(b);
        },
        .array => |xs| {
            if (b != .array or b.array.items.len != xs.items.len) return false;
            for (xs.items, b.array.items) |ea, eb| if (!jsonEql(ea, eb)) return false;
            return true;
        },
        .object => |xo| {
            if (b != .object or b.object.count() != xo.count()) return false;
            var it = xo.iterator();
            while (it.next()) |e| {
                const ov = b.object.get(e.key_ptr.*) orelse return false;
                if (!jsonEql(e.value_ptr.*, ov)) return false;
            }
            return true;
        },
    }
}

fn numVal(v: std.json.Value) f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        .number_string => |ns| std.fmt.parseFloat(f64, ns) catch std.math.nan(f64),
        else => std.math.nan(f64),
    };
}

/// JSON.stringify-equivalent for error messages (best-effort; used only in
/// human-readable failure text).
fn jsonStr(alloc: std.mem.Allocator, v: std.json.Value) ![]const u8 {
    return std.fmt.allocPrint(alloc, "{f}", .{std.json.fmt(v, .{})});
}

// ===========================================================================
// Tests — mirror the pure-path cases from lib/js/test/object.test.ts and the
// validator cases from lib/js/test/tool_args.test.ts.

const testing = std.testing;

fn parseJson(arena: std.mem.Allocator, src: []const u8) !std.json.Value {
    return std.json.parseFromSliceLeaky(std.json.Value, arena, src, .{});
}

// ---------- JSON extraction (object.ts 113–120) ----------

test "extractObject: returns parsed object matching the schema" {
    var a = std.heap.ArenaAllocator.init(testing.allocator);
    defer a.deinit();
    const schema = try parseJson(a.allocator(),
        \\{"type":"object","properties":{"name":{"type":"string"},
        \\ "ingredients":{"type":"array","items":{"type":"string"}}},
        \\ "required":["name","ingredients"]}
    );
    var ext = try extractObject(
        testing.allocator,
        "{\"name\":\"Lasagna\",\"ingredients\":[\"pasta\",\"cheese\"]}",
        schema,
        null,
    );
    defer ext.deinit();
    try testing.expectEqualStrings("Lasagna", ext.value.object.get("name").?.string);
    try testing.expectEqual(@as(usize, 2), ext.value.object.get("ingredients").?.array.items.len);
}

test "extractObject: non-JSON content → NonJsonContent with snippet" {
    var schema_arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer schema_arena.deinit();
    const schema = try parseJson(schema_arena.allocator(),
        \\{"type":"object","properties":{"x":{"type":"number"}},"required":["x"]}
    );
    var f: ValidationFailure = undefined;
    try testing.expectError(error.NonJsonContent, extractObject(
        testing.allocator,
        "not actually json",
        schema,
        &f,
    ));
    defer f.deinit(testing.allocator);
    try testing.expect(std.mem.startsWith(u8, f.message, "model returned non-JSON content: not actually json"));
}

test "extractObject: snippet is truncated to first 200 chars" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(), "{\"type\":\"object\"}");
    const big = "x" ** 500; // not valid JSON
    var f: ValidationFailure = undefined;
    try testing.expectError(error.NonJsonContent, extractObject(testing.allocator, big, schema, &f));
    defer f.deinit(testing.allocator);
    // "model returned non-JSON content: " (33) + 200
    try testing.expectEqual(@as(usize, 33 + 200), f.message.len);
}

// ---------- schema validation (tool_args.ts validate) ----------

test "extractObject: missing required field → SchemaValidationFailed" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"x":{"type":"number"}},"required":["x"]}
    );
    var f: ValidationFailure = undefined;
    try testing.expectError(error.SchemaValidationFailed, extractObject(
        testing.allocator,
        "{\"y\":1}",
        schema,
        &f,
    ));
    defer f.deinit(testing.allocator);
    try testing.expectEqualStrings("", f.path);
    try testing.expectEqualStrings("missing required field \"x\"", f.message);

    const human = try formatSchemaError(testing.allocator, f);
    defer testing.allocator.free(human);
    try testing.expectEqualStrings(
        "schema validation failed: luv-js: parseArguments failed at <root>: missing required field \"x\"",
        human,
    );
}

test "validate: nested object schemas pass" {
    var a = std.heap.ArenaAllocator.init(testing.allocator);
    defer a.deinit();
    const schema = try parseJson(a.allocator(),
        \\{"type":"object","properties":{"recipe":{"type":"object",
        \\ "properties":{"name":{"type":"string"},
        \\ "steps":{"type":"array","items":{"type":"string"}}},
        \\ "required":["name","steps"]}},"required":["recipe"]}
    );
    var ext = try extractObject(
        testing.allocator,
        "{\"recipe\":{\"name\":\"Pancakes\",\"steps\":[\"mix\",\"cook\"]}}",
        schema,
        null,
    );
    defer ext.deinit();
    try testing.expectEqualStrings(
        "Pancakes",
        ext.value.object.get("recipe").?.object.get("name").?.string,
    );
}

test "validate: wrong type reports path and message" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}
    );
    var f: ValidationFailure = undefined;
    try testing.expectError(error.SchemaValidationFailed, extractObject(
        testing.allocator,
        "{\"city\":42}",
        schema,
        &f,
    ));
    defer f.deinit(testing.allocator);
    try testing.expectEqualStrings("city", f.path);
    try testing.expectEqualStrings("expected string, got number", f.message);
}

test "validate: nested object path is dotted" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"profile":{"type":"object",
        \\ "properties":{"name":{"type":"string"}},"required":["name"]}},
        \\ "required":["profile"]}
    );
    var f: ValidationFailure = undefined;
    try testing.expectError(error.SchemaValidationFailed, extractObject(
        testing.allocator,
        "{\"profile\":{\"name\":42}}",
        schema,
        &f,
    ));
    defer f.deinit(testing.allocator);
    try testing.expectEqualStrings("profile.name", f.path);
}

test "validate: array item path uses [i] notation" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"items":{"type":"array",
        \\ "items":{"type":"string"}}},"required":["items"]}
    );
    var f: ValidationFailure = undefined;
    try testing.expectError(error.SchemaValidationFailed, extractObject(
        testing.allocator,
        "{\"items\":[\"a\",5]}",
        schema,
        &f,
    ));
    defer f.deinit(testing.allocator);
    try testing.expectEqualStrings("items[1]", f.path);
}

test "validate: array of objects validates each item" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"users":{"type":"array",
        \\ "items":{"type":"object","properties":{"name":{"type":"string"}},
        \\ "required":["name"]}}},"required":["users"]}
    );
    var ok = try extractObject(
        testing.allocator,
        "{\"users\":[{\"name\":\"a\"},{\"name\":\"b\"}]}",
        schema,
        null,
    );
    ok.deinit();

    var f: ValidationFailure = undefined;
    try testing.expectError(error.SchemaValidationFailed, extractObject(
        testing.allocator,
        "{\"users\":[{\"name\":\"a\"},{\"age\":5}]}",
        schema,
        &f,
    ));
    defer f.deinit(testing.allocator);
    try testing.expectEqualStrings("users[1]", f.path);
    try testing.expectEqualStrings("missing required field \"name\"", f.message);
}

test "validate: enum constraint enforced" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"mode":{"type":"string",
        \\ "enum":["fast","slow"]}},"required":["mode"]}
    );
    var ok = try extractObject(testing.allocator, "{\"mode\":\"fast\"}", schema, null);
    ok.deinit();

    var f: ValidationFailure = undefined;
    try testing.expectError(error.SchemaValidationFailed, extractObject(
        testing.allocator,
        "{\"mode\":\"auto\"}",
        schema,
        &f,
    ));
    f.deinit(testing.allocator);
}

test "validate: const enforces a single literal value" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"kind":{"const":"request"}},
        \\ "required":["kind"]}
    );
    var ok = try extractObject(testing.allocator, "{\"kind\":\"request\"}", schema, null);
    ok.deinit();

    var f: ValidationFailure = undefined;
    try testing.expectError(error.SchemaValidationFailed, extractObject(
        testing.allocator,
        "{\"kind\":\"response\"}",
        schema,
        &f,
    ));
    f.deinit(testing.allocator);
}

test "validate: integer rejects floats, accepts whole numbers" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"count":{"type":"integer"}},
        \\ "required":["count"]}
    );
    var ok = try extractObject(testing.allocator, "{\"count\":42}", schema, null);
    ok.deinit();

    var f: ValidationFailure = undefined;
    try testing.expectError(error.SchemaValidationFailed, extractObject(
        testing.allocator,
        "{\"count\":1.5}",
        schema,
        &f,
    ));
    defer f.deinit(testing.allocator);
    try testing.expectEqualStrings("expected integer, got number", f.message);
}

test "validate: number accepts both integers and floats" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"x":{"type":"number"}},"required":["x"]}
    );
    var a = try extractObject(testing.allocator, "{\"x\":42}", schema, null);
    a.deinit();
    var b = try extractObject(testing.allocator, "{\"x\":1.5}", schema, null);
    b.deinit();
}

test "validate: boolean rejects non-booleans" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"flag":{"type":"boolean"}},
        \\ "required":["flag"]}
    );
    var f: ValidationFailure = undefined;
    try testing.expectError(error.SchemaValidationFailed, extractObject(
        testing.allocator,
        "{\"flag\":\"true\"}",
        schema,
        &f,
    ));
    defer f.deinit(testing.allocator);
    try testing.expectEqualStrings("expected boolean, got string", f.message);
}

test "validate: null type accepts null only" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"x":{"type":"null"}},"required":["x"]}
    );
    var ok = try extractObject(testing.allocator, "{\"x\":null}", schema, null);
    ok.deinit();

    var f: ValidationFailure = undefined;
    try testing.expectError(error.SchemaValidationFailed, extractObject(
        testing.allocator,
        "{\"x\":1}",
        schema,
        &f,
    ));
    f.deinit(testing.allocator);
}

test "validate: extra properties not in schema are accepted (no strict mode)" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{"name":{"type":"string"}},
        \\ "required":["name"]}
    );
    var ext = try extractObject(
        testing.allocator,
        "{\"name\":\"Sam\",\"extra\":\"field\"}",
        schema,
        null,
    );
    defer ext.deinit();
    try testing.expectEqualStrings("Sam", ext.value.object.get("name").?.string);
}

test "validate: non-object schema accepts anything" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    // schema is a JSON `true` (not an object) → validate returns immediately
    const schema = try parseJson(sa.allocator(), "true");
    var ext = try extractObject(testing.allocator, "{\"whatever\":1}", schema, null);
    defer ext.deinit();
}

test "validate: unknown/absent type accepts anything" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(), "{\"description\":\"freeform\"}");
    var ext = try extractObject(testing.allocator, "[1,2,3]", schema, null);
    defer ext.deinit();
}

test "validate: empty-properties object schema with empty object" {
    var sa = std.heap.ArenaAllocator.init(testing.allocator);
    defer sa.deinit();
    const schema = try parseJson(sa.allocator(),
        \\{"type":"object","properties":{},"required":[]}
    );
    var ext = try extractObject(testing.allocator, "{}", schema, null);
    defer ext.deinit();
}
