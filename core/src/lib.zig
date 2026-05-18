pub const luv = @import("morphisms/luv/luv.zig");
pub const luv_stream = @import("morphisms/luv/luv_stream.zig");
pub const luv_tool_calls = @import("morphisms/luv/tool_calls.zig");
pub const openai = @import("morphisms/openai/openai.zig");
pub const openai_stream = @import("morphisms/openai/openai_stream.zig");
pub const transport = @import("transport/transport.zig");
pub const transport_http = @import("transport/http.zig");
pub const transport_mock = @import("transport/mock.zig");
pub const requester_openai = @import("requesters/openai/openai.zig");
pub const requester_openai_stream = @import("requesters/openai/openai_stream.zig");
pub const wasm_codec = @import("wasm_abi/codec.zig");
pub const wasm_effect = @import("wasm_abi/effect.zig");
pub const wasm_exports = @import("wasm_abi/exports.zig");
pub const agent = @import("agent/agent.zig");

// Force analysis of the wasm_abi/exports.zig file so its `export fn`
// declarations land in the wasm artifact even when nothing in this file
// references them directly.
comptime {
    _ = wasm_exports;
}

const greeting = "Hello World!";

export fn greet_ptr() [*]const u8 {
    return greeting.ptr;
}

export fn greet_len() usize {
    return greeting.len;
}

test {
    _ = luv;
    _ = luv_stream;
    _ = luv_tool_calls;
    _ = openai;
    _ = openai_stream;
    _ = transport;
    _ = transport_http;
    _ = transport_mock;
    _ = requester_openai;
    _ = requester_openai_stream;
    _ = wasm_codec;
    _ = wasm_effect;
    _ = wasm_exports;
    _ = agent;
}
