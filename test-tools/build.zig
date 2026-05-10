const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Cross-package import: core's lib.zig lives in a sibling directory.
    // `b.path()` accepts paths outside the build root.
    const core_module = b.createModule(.{
        .root_source_file = b.path("../core/src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });

    const e2e_step = b.step("e2e", "Run live-API integration tests for the openai requester");

    addE2eTest(b, e2e_step, target, optimize, core_module, "openai_send", "e2e/openai_send.zig");
    addE2eTest(b, e2e_step, target, optimize, core_module, "openai_stream", "e2e/openai_stream.zig");

    // `zig fmt --check` over the test-tools tree.
    const fmt = b.addFmt(.{
        .paths = &.{ "build.zig", "e2e", "record_openai.zig" },
        .check = true,
    });
    const fmt_step = b.step("fmt", "Check formatting of test-tools sources");
    fmt_step.dependOn(&fmt.step);
}

fn addE2eTest(
    b: *std.Build,
    parent_step: *std.Build.Step,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    core_module: *std.Build.Module,
    name: []const u8,
    rel_path: []const u8,
) void {
    const test_artifact = b.addTest(.{
        .name = name,
        .root_module = b.createModule(.{
            .root_source_file = b.path(rel_path),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "luv_core", .module = core_module },
            },
        }),
    });
    const run = b.addRunArtifact(test_artifact);
    parent_step.dependOn(&run.step);
}
