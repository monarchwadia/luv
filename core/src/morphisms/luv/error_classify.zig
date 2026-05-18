//! Pure classification of an upstream-LLM HTTP failure into an error kind.
//!
//! This is the Zig mirror of the *pure logic* in lib/js/src/errors.ts
//! (`classifyError` + the status/body → subclass taxonomy). It deliberately
//! does NOT construct host error objects: it returns a tagged enum/value so
//! callers can decide how to surface it.
//!
//! TS taxonomy mapping (kept byte-for-byte equivalent):
//!   - 401, 403                              → .auth          (AuthError)
//!   - 429                                   → .rate_limit    (RateLimitError, retry_after_ms parsed)
//!   - 400 + error.code == "context_length_exceeded"
//!                                           → .context_window_exceeded (ContextWindowExceededError)
//!   - 400 + (error.type == "content_filter_error"
//!            OR error.code == "content_filter")
//!                                           → .content_filter (ContentFilterError)
//!   - 500..=599                             → .service_unavailable (ServiceUnavailableError)
//!   - anything else                         → .http          (generic HttpError)
//!
//! Body is parsed as JSON of shape `{ "error": { "message"?, "type"?, "code"? } }`;
//! a non-JSON / malformed body falls through and classification proceeds by
//! status alone (matching the TS `try { JSON.parse } catch {}` behaviour).

const std = @import("std");

/// The discriminant of the error taxonomy. One-to-one with the TS subclasses.
pub const ErrorKind = enum {
    /// HTTP 401 / 403 — AuthError.
    auth,
    /// HTTP 429 — RateLimitError.
    rate_limit,
    /// HTTP 400 + code "context_length_exceeded" — ContextWindowExceededError.
    context_window_exceeded,
    /// HTTP 400 + content-filter signal — ContentFilterError.
    content_filter,
    /// HTTP 5xx — ServiceUnavailableError.
    service_unavailable,
    /// Generic / unclassified — HttpError.
    http,
};

/// Result of classification. `status` is echoed back for convenience.
/// `retry_after_ms` is only ever populated for `.rate_limit` and only when a
/// usable `Retry-After` header was supplied (numeric seconds, or an HTTP-date
/// in the future / clamped to 0 if in the past). It is null otherwise — the
/// equivalent of TS `retryAfterMs === undefined`.
pub const Classification = struct {
    kind: ErrorKind,
    status: u16,
    retry_after_ms: ?u64 = null,
};

const ErrorBody = struct {
    code: ?[]const u8 = null,
    type_: ?[]const u8 = null,

    /// True iff `code` equals `want` (mirrors `parsed?.error?.code === want`).
    fn codeIs(self: ErrorBody, want: []const u8) bool {
        return self.code != null and std.mem.eql(u8, self.code.?, want);
    }
    /// True iff `type` equals `want` (mirrors `parsed?.error?.type === want`).
    fn typeIs(self: ErrorBody, want: []const u8) bool {
        return self.type_ != null and std.mem.eql(u8, self.type_.?, want);
    }
};

/// Extract `error.code` / `error.type` from a JSON body. Returns an all-null
/// `ErrorBody` if the body is empty, not JSON, not an object, or lacks an
/// `error` object — mirroring the optional-chaining (`parsed?.error?.code`)
/// in the TS source.
///
/// The returned slices borrow from `parsed`; the caller MUST keep `parsed`
/// alive for as long as the result is used (and `deinit` it afterwards).
fn parseErrorBody(parsed: *const std.json.Parsed(std.json.Value)) ErrorBody {
    const root = parsed.value;
    if (root != .object) return .{};
    const err_val = root.object.get("error") orelse return .{};
    if (err_val != .object) return .{};

    var out: ErrorBody = .{};
    if (err_val.object.get("code")) |c| {
        if (c == .string) out.code = c.string;
    }
    if (err_val.object.get("type")) |t| {
        if (t == .string) out.type_ = t.string;
    }
    return out;
}

/// Pure port of TS `parseRetryAfter`, made deterministic by taking the
/// current time explicitly (`now_ms`). The TS version supports:
///   - all-ASCII-digit string → seconds, returned as `n * 1000` ms
///   - an HTTP-date            → `max(date - now, 0)` ms
///   - anything else / null    → undefined  (here: null)
///
/// `now_ms` is unix-epoch milliseconds; ignored for the numeric-seconds case.
pub fn parseRetryAfter(value: ?[]const u8, now_ms: i64) ?u64 {
    const raw = value orelse return null;
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (trimmed.len == 0) return null;

    // /^\d+$/ — pure-digits → integer seconds.
    var all_digits = true;
    for (trimmed) |ch| {
        if (ch < '0' or ch > '9') {
            all_digits = false;
            break;
        }
    }
    if (all_digits) {
        const secs = std.fmt.parseInt(u64, trimmed, 10) catch return null;
        return secs * 1000;
    }

    // HTTP-date → delta from now, clamped at 0.
    const date_ms = parseHttpDate(trimmed) orelse return null;
    const delta = date_ms - now_ms;
    return if (delta > 0) @intCast(delta) else 0;
}

const month_names = [_][]const u8{
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
};

/// Parse an IMF-fixdate HTTP-date ("Sun, 06 Nov 1994 08:49:37 GMT") into unix
/// epoch milliseconds. Returns null on any deviation. This is the only RFC
/// 7231 form emitted by JS `Date.prototype.toUTCString()`, which the TS tests
/// exercise via `Date.parse`. Other obsolete formats are intentionally not
/// supported (they are not produced by the codepaths under test).
fn parseHttpDate(s: []const u8) ?i64 {
    // "Www, DD Mon YYYY HH:MM:SS GMT" — 29 chars.
    if (s.len != 29) return null;
    if (s[3] != ',' or s[4] != ' ') return null;
    if (!std.mem.eql(u8, s[25..29], " GMT")) return null;

    const day = parseFixed(s[5..7]) orelse return null;
    if (s[7] != ' ') return null;

    const mon_str = s[8..11];
    var month: u8 = 0;
    var found = false;
    for (month_names, 0..) |m, i| {
        if (std.mem.eql(u8, m, mon_str)) {
            month = @intCast(i);
            found = true;
            break;
        }
    }
    if (!found) return null;
    if (s[11] != ' ') return null;

    const year = parse4(s[12..16]) orelse return null;
    if (s[16] != ' ') return null;

    const hour = parseFixed(s[17..19]) orelse return null;
    if (s[19] != ':') return null;
    const min = parseFixed(s[20..22]) orelse return null;
    if (s[22] != ':') return null;
    const sec = parseFixed(s[23..25]) orelse return null;

    if (month > 11 or day < 1 or day > 31 or hour > 23 or min > 59 or sec > 60) return null;

    const epoch_days = daysFromCivil(year, month + 1, day);
    const total_secs: i64 =
        epoch_days * 86400 +
        @as(i64, hour) * 3600 +
        @as(i64, min) * 60 +
        @as(i64, sec);
    return total_secs * 1000;
}

fn parseFixed(two: []const u8) ?u8 {
    if (two.len != 2) return null;
    if (two[0] < '0' or two[0] > '9' or two[1] < '0' or two[1] > '9') return null;
    return (two[0] - '0') * 10 + (two[1] - '0');
}

fn parse4(four: []const u8) ?i64 {
    if (four.len != 4) return null;
    var n: i64 = 0;
    for (four) |c| {
        if (c < '0' or c > '9') return null;
        n = n * 10 + (c - '0');
    }
    return n;
}

/// Days from 1970-01-01 to civil date (Howard Hinnant's algorithm).
/// `m` is 1..12, `d` is 1..31.
fn daysFromCivil(y_in: i64, m: i64, d: i64) i64 {
    const y = if (m <= 2) y_in - 1 else y_in;
    const era = @divFloor(if (y >= 0) y else y - 399, 400);
    const yoe = y - era * 400; // [0, 399]
    const doy = @divFloor(153 * (if (m > 2) m - 3 else m + 9) + 2, 5) + d - 1; // [0, 365]
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy; // [0, 146096]
    return era * 146097 + doe - 719468;
}

/// Classify an upstream HTTP failure. Pure: depends only on its inputs.
///
/// - `status`             — the HTTP status code.
/// - `body`               — the raw response body (may be empty / non-JSON).
/// - `retry_after_header` — the raw `Retry-After` header value, or null.
/// - `now_ms`             — unix-epoch ms, used only to resolve an HTTP-date
///                          `Retry-After`. Pass `std.time.milliTimestamp()`
///                          at the call site; injected here for determinism.
/// - `alloc`              — scratch allocator for transient JSON parsing;
///                          nothing is returned that borrows from it.
pub fn classifyError(
    alloc: std.mem.Allocator,
    status: u16,
    body: []const u8,
    retry_after_header: ?[]const u8,
    now_ms: i64,
) Classification {
    // Parse the body once; keep the tree alive for the whole function so the
    // borrowed `code`/`type` slices stay valid (matches TS `try/catch` body
    // parse falling through to undefined on non-JSON input).
    var maybe_parsed: ?std.json.Parsed(std.json.Value) =
        if (body.len == 0) null else std.json.parseFromSlice(std.json.Value, alloc, body, .{}) catch null;
    defer if (maybe_parsed) |*p| p.deinit();

    const eb: ErrorBody = if (maybe_parsed) |*p| parseErrorBody(p) else .{};

    if (status == 401 or status == 403) {
        return .{ .kind = .auth, .status = status };
    }
    if (status == 429) {
        return .{
            .kind = .rate_limit,
            .status = status,
            .retry_after_ms = parseRetryAfter(retry_after_header, now_ms),
        };
    }
    if (status == 400 and eb.codeIs("context_length_exceeded")) {
        return .{ .kind = .context_window_exceeded, .status = status };
    }
    if (status == 400 and (eb.typeIs("content_filter_error") or eb.codeIs("content_filter"))) {
        return .{ .kind = .content_filter, .status = status };
    }
    if (status >= 500 and status < 600) {
        return .{ .kind = .service_unavailable, .status = status };
    }
    return .{ .kind = .http, .status = status };
}

// ===========================================================================
// Tests — mirror lib/js/test/errors.test.ts classification cases.

const testing = std.testing;

test "classifyError: 401 → auth" {
    const c = classifyError(testing.allocator, 401, "", null, 0);
    try testing.expectEqual(ErrorKind.auth, c.kind);
    try testing.expectEqual(@as(u16, 401), c.status);
}

test "classifyError: 403 also maps to auth (not just 401)" {
    const c = classifyError(testing.allocator, 403, "", null, 0);
    try testing.expectEqual(ErrorKind.auth, c.kind);
}

test "classifyError: 429 → rate_limit, numeric-seconds Retry-After → ms" {
    const c = classifyError(
        testing.allocator,
        429,
        "{\"error\":{\"message\":\"rate limited\"}}",
        "30",
        0,
    );
    try testing.expectEqual(ErrorKind.rate_limit, c.kind);
    try testing.expectEqual(@as(u16, 429), c.status);
    try testing.expectEqual(@as(?u64, 30_000), c.retry_after_ms);
}

test "classifyError: 429 with future HTTP-date Retry-After is parsed" {
    // now = 0; date = 60s in the future.
    // 1970-01-01 00:01:00 GMT
    const c = classifyError(
        testing.allocator,
        429,
        "",
        "Thu, 01 Jan 1970 00:01:00 GMT",
        0,
    );
    try testing.expectEqual(ErrorKind.rate_limit, c.kind);
    try testing.expectEqual(@as(?u64, 60_000), c.retry_after_ms);
}

test "classifyError: HTTP-date in the past clamps retry_after_ms to 0" {
    // now well after the date.
    const c = classifyError(
        testing.allocator,
        429,
        "",
        "Thu, 01 Jan 1970 00:01:00 GMT",
        9_999_999_999,
    );
    try testing.expectEqual(@as(?u64, 0), c.retry_after_ms);
}

test "classifyError: 429 without Retry-After → retry_after_ms null" {
    const c = classifyError(testing.allocator, 429, "", null, 0);
    try testing.expectEqual(ErrorKind.rate_limit, c.kind);
    try testing.expectEqual(@as(?u64, null), c.retry_after_ms);
}

test "classifyError: invalid Retry-After value → retry_after_ms null" {
    const c = classifyError(testing.allocator, 429, "", "garbage", 0);
    try testing.expectEqual(ErrorKind.rate_limit, c.kind);
    try testing.expectEqual(@as(?u64, null), c.retry_after_ms);
}

test "classifyError: 400 + code=context_length_exceeded → context_window_exceeded" {
    const body = "{\"error\":{\"message\":\"too long\",\"code\":\"context_length_exceeded\"}}";
    const c = classifyError(testing.allocator, 400, body, null, 0);
    try testing.expectEqual(ErrorKind.context_window_exceeded, c.kind);
}

test "classifyError: 400 + type=content_filter_error → content_filter" {
    const body = "{\"error\":{\"message\":\"filtered\",\"type\":\"content_filter_error\"}}";
    const c = classifyError(testing.allocator, 400, body, null, 0);
    try testing.expectEqual(ErrorKind.content_filter, c.kind);
}

test "classifyError: 400 + code=content_filter (alternate spelling) → content_filter" {
    const body = "{\"error\":{\"code\":\"content_filter\"}}";
    const c = classifyError(testing.allocator, 400, body, null, 0);
    try testing.expectEqual(ErrorKind.content_filter, c.kind);
}

test "classifyError: 5xx → service_unavailable" {
    try testing.expectEqual(
        ErrorKind.service_unavailable,
        classifyError(testing.allocator, 500, "", null, 0).kind,
    );
    try testing.expectEqual(
        ErrorKind.service_unavailable,
        classifyError(testing.allocator, 503, "", null, 0).kind,
    );
}

test "classifyError: 599 (non-standard 5xx) → service_unavailable" {
    const c = classifyError(testing.allocator, 599, "", null, 0);
    try testing.expectEqual(ErrorKind.service_unavailable, c.kind);
}

test "classifyError: 500 with no body → service_unavailable" {
    const c = classifyError(testing.allocator, 500, "", null, 0);
    try testing.expectEqual(ErrorKind.service_unavailable, c.kind);
    try testing.expectEqual(@as(u16, 500), c.status);
}

test "classifyError: unknown 4xx falls back to generic http" {
    const c = classifyError(testing.allocator, 418, "", null, 0);
    try testing.expectEqual(ErrorKind.http, c.kind);
}

test "classifyError: malformed JSON body still classifies by status alone" {
    try testing.expectEqual(
        ErrorKind.rate_limit,
        classifyError(testing.allocator, 429, "definitely not json", null, 0).kind,
    );
    try testing.expectEqual(
        ErrorKind.auth,
        classifyError(testing.allocator, 401, "<html>error</html>", null, 0).kind,
    );
    try testing.expectEqual(
        ErrorKind.service_unavailable,
        classifyError(testing.allocator, 503, "Service Unavailable", null, 0).kind,
    );
}

test "classifyError: 400 with non-JSON body → generic http (no context/filter signal)" {
    const c = classifyError(testing.allocator, 400, "bad request", null, 0);
    try testing.expectEqual(ErrorKind.http, c.kind);
}

test "classifyError: 400 with unrelated error code → generic http" {
    const body = "{\"error\":{\"code\":\"invalid_request\"}}";
    const c = classifyError(testing.allocator, 400, body, null, 0);
    try testing.expectEqual(ErrorKind.http, c.kind);
}

test "classifyError: context_length code wins over 5xx-range only at 400" {
    // 500 with the context code is still service_unavailable (status checked first).
    const body = "{\"error\":{\"code\":\"context_length_exceeded\"}}";
    const c = classifyError(testing.allocator, 500, body, null, 0);
    try testing.expectEqual(ErrorKind.service_unavailable, c.kind);
}

test "parseRetryAfter: numeric seconds → ms; whitespace trimmed" {
    try testing.expectEqual(@as(?u64, 5_000), parseRetryAfter("5", 0));
    try testing.expectEqual(@as(?u64, 12_000), parseRetryAfter("  12  ", 0));
    try testing.expectEqual(@as(?u64, 0), parseRetryAfter("0", 0));
}

test "parseRetryAfter: null / empty / garbage → null" {
    try testing.expectEqual(@as(?u64, null), parseRetryAfter(null, 0));
    try testing.expectEqual(@as(?u64, null), parseRetryAfter("", 0));
    try testing.expectEqual(@as(?u64, null), parseRetryAfter("   ", 0));
    try testing.expectEqual(@as(?u64, null), parseRetryAfter("soon", 0));
}

test "parseRetryAfter: HTTP-date sanity (epoch + 1h)" {
    // 1970-01-01 01:00:00 GMT == 3_600_000 ms since epoch.
    try testing.expectEqual(
        @as(?u64, 3_600_000),
        parseRetryAfter("Thu, 01 Jan 1970 01:00:00 GMT", 0),
    );
}

test "parseHttpDate: known reference date (RFC 7231 example)" {
    // Sun, 06 Nov 1994 08:49:37 GMT == 784111777 unix seconds.
    const ms = parseHttpDate("Sun, 06 Nov 1994 08:49:37 GMT").?;
    try testing.expectEqual(@as(i64, 784111777 * 1000), ms);
}

test "parseHttpDate: rejects malformed shapes" {
    try testing.expectEqual(@as(?i64, null), parseHttpDate("not a date"));
    try testing.expectEqual(@as(?i64, null), parseHttpDate("Sun, 06 Nov 1994 08:49:37 UTC"));
    try testing.expectEqual(@as(?i64, null), parseHttpDate("Xxx, 06 Zzz 1994 08:49:37 GMT"));
}
