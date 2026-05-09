const std = @import("std");
const Io = std.Io;

pub fn main(init: std.process.Init) !void {
    var stdout_buffer: [64]u8 = undefined;
    var stdout_file_writer: Io.File.Writer = .init(.stdout(), init.io, &stdout_buffer);
    const stdout = &stdout_file_writer.interface;
    try stdout.print("Hello World!\n", .{});
    try stdout.flush();
}

test "smoke" {
    try std.testing.expect(true);
}
