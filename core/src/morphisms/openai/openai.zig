//! Pure mapping between luv.Conversation/Reply and OpenAI Chat Completions wire JSON.
//! No I/O. Optional null fields are omitted on serialization (matches real requests).
//!
//! Loss table (luv ↔ openai):
//!
//! luv → openai (toOpenAI):
//!   - Role.system | .user | .assistant → "system" | "user" | "assistant" lowercase strings.
//!   - Conversation order is preserved verbatim; consecutive same-role accepted.
//!   - Options.{model,max_tokens,temperature,stream} added at request level — luv has no concept of these.
//!   - Dropped (never emitted): name, tools, tool_choice, response_format, n, stop, seed, stream_options,
//!     logprobs, top_logprobs, top_p, presence/frequency_penalty, audio, modalities, prediction, metadata,
//!     store, service_tier, user, parallel_tool_calls.
//!
//! openai → luv (fromOpenAI):
//!   - First choice only is taken (n>1 is out of scope).
//!   - choice.message.role coerced to luv.Role.assistant unconditionally.
//!   - choice.message.content used; if null, choice.message.refusal is substituted (lossy: we don't tag it).
//!   - finish_reason mapped: "stop" → end_turn, "length" → max_tokens, "content_filter" → content_filter,
//!     "tool_calls"/"function_call" → tool_use, anything else → other.
//!   - Dropped: id, object, created, model, system_fingerprint, service_tier, usage (all subfields),
//!     choice.index, choice.logprobs, message.annotations, message.audio, message.tool_calls.

const std = @import("std");
const luv = @import("../luv/luv.zig");

pub const Options = struct {
    model: []const u8,
    max_tokens: ?u32 = null,
    temperature: ?f32 = null,
    stream: bool = false,
};

pub const RequestMessage = struct {
    role: []const u8,
    content: []const u8,
};

pub const Request = struct {
    model: []const u8,
    messages: []const RequestMessage,
    max_tokens: ?u32 = null,
    temperature: ?f32 = null,
    stream: ?bool = null,
};

pub const ResponseMessage = struct {
    role: []const u8,
    content: ?[]const u8 = null,
    refusal: ?[]const u8 = null,
};

pub const Choice = struct {
    index: u32,
    message: ResponseMessage,
    finish_reason: []const u8,
};

pub const Usage = struct {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
};

pub const Response = struct {
    id: []const u8,
    object: []const u8,
    created: i64,
    model: []const u8,
    choices: []const Choice,
    usage: Usage,
};

fn roleToString(r: luv.Role) []const u8 {
    return switch (r) {
        .system => "system",
        .user => "user",
        .assistant => "assistant",
    };
}

fn stopReasonFrom(s: []const u8) luv.StopReason {
    if (std.mem.eql(u8, s, "stop")) return .end_turn;
    if (std.mem.eql(u8, s, "length")) return .max_tokens;
    if (std.mem.eql(u8, s, "content_filter")) return .content_filter;
    if (std.mem.eql(u8, s, "tool_calls")) return .tool_use;
    if (std.mem.eql(u8, s, "function_call")) return .tool_use;
    return .other;
}

/// Build an OpenAI Request from a luv conversation. Caller owns `request.messages`.
/// Message content slices are borrowed from `messages` and must outlive serialization.
pub fn toOpenAI(
    messages: luv.Conversation,
    opts: Options,
    alloc: std.mem.Allocator,
) !Request {
    const out = try alloc.alloc(RequestMessage, messages.len);
    errdefer alloc.free(out);
    for (messages, 0..) |m, i| {
        out[i] = .{
            .role = roleToString(m.role),
            .content = m.text,
        };
    }
    return .{
        .model = opts.model,
        .messages = out,
        .max_tokens = opts.max_tokens,
        .temperature = opts.temperature,
        .stream = if (opts.stream) true else null,
    };
}

pub const FromError = error{NoChoices} || std.mem.Allocator.Error;

/// Convert a parsed OpenAI Response into a luv.Reply. Caller owns `reply.message.text`.
pub fn fromOpenAI(resp: Response, alloc: std.mem.Allocator) FromError!luv.Reply {
    if (resp.choices.len == 0) return error.NoChoices;
    const choice = resp.choices[0];
    const text = choice.message.content orelse choice.message.refusal orelse "";
    const owned = try alloc.dupe(u8, text);
    return .{
        .message = .{ .role = .assistant, .text = owned },
        .stop_reason = stopReasonFrom(choice.finish_reason),
    };
}

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;

const max_fixture_bytes: usize = 1 * 1024 * 1024;

fn loadFixture(rel_path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(
        testing.io,
        rel_path,
        testing.allocator,
        .limited(max_fixture_bytes),
    );
}

/// Recursive structural equality for parsed JSON values.
/// Numbers compare by canonical f64; objects/arrays compare deeply.
fn jsonEqual(a: std.json.Value, b: std.json.Value) bool {
    if (@as(std.meta.Tag(std.json.Value), a) != @as(std.meta.Tag(std.json.Value), b)) return false;
    return switch (a) {
        .null => true,
        .bool => a.bool == b.bool,
        .integer => a.integer == b.integer,
        .float => a.float == b.float,
        .number_string => std.mem.eql(u8, a.number_string, b.number_string),
        .string => std.mem.eql(u8, a.string, b.string),
        .array => blk: {
            if (a.array.items.len != b.array.items.len) break :blk false;
            for (a.array.items, b.array.items) |x, y| {
                if (!jsonEqual(x, y)) break :blk false;
            }
            break :blk true;
        },
        .object => blk: {
            if (a.object.count() != b.object.count()) break :blk false;
            var it = a.object.iterator();
            while (it.next()) |entry| {
                const other = b.object.get(entry.key_ptr.*) orelse break :blk false;
                if (!jsonEqual(entry.value_ptr.*, other)) break :blk false;
            }
            break :blk true;
        },
    };
}

test "to_openai: 001_single_user matches fixture request.json" {
    const messages = [_]luv.Message{
        .{ .role = .user, .text = "Say hello in one short sentence." },
    };

    const req = try toOpenAI(&messages, .{
        .model = "gpt-4o-mini",
        .max_tokens = 32,
        .temperature = 0,
    }, testing.allocator);
    defer testing.allocator.free(req.messages);

    const actual = try std.json.Stringify.valueAlloc(testing.allocator, req, .{
        .emit_null_optional_fields = false,
    });
    defer testing.allocator.free(actual);

    const actual_parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, actual, .{});
    defer actual_parsed.deinit();

    const fixture = try loadFixture("fixtures/openai/001_single_user/request.json");
    defer testing.allocator.free(fixture);
    const expected_parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, fixture, .{});
    defer expected_parsed.deinit();

    try testing.expect(jsonEqual(actual_parsed.value, expected_parsed.value));
}

test "from_openai: 001_single_user yields assistant Reply with end_turn" {
    const fixture = try loadFixture("fixtures/openai/001_single_user/response.json");
    defer testing.allocator.free(fixture);
    const parsed = try std.json.parseFromSlice(Response, testing.allocator, fixture, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();

    const reply = try fromOpenAI(parsed.value, testing.allocator);
    defer testing.allocator.free(reply.message.text);

    try testing.expectEqual(luv.Role.assistant, reply.message.role);
    try testing.expect(reply.message.text.len > 0);
    try testing.expectEqual(luv.StopReason.end_turn, reply.stop_reason);
}
