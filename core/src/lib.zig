pub const luv = @import("morphisms/luv.zig");

const greeting = "Hello World!";

export fn greet_ptr() [*]const u8 {
    return greeting.ptr;
}

export fn greet_len() usize {
    return greeting.len;
}

test {
    _ = luv;
}
