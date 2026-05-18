const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "luv_core",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);
    const run_step = b.step("run", "Run the app");
    run_step.dependOn(&run_cmd.step);

    const exe_tests = b.addTest(.{ .root_module = exe.root_module });
    const run_exe_tests = b.addRunArtifact(exe_tests);
    const test_step = b.step("test", "Run tests");
    test_step.dependOn(&run_exe_tests.step);

    const lib_module_for_test = b.createModule(.{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });
    const lib_tests = b.addTest(.{ .root_module = lib_module_for_test });
    const run_lib_tests = b.addRunArtifact(lib_tests);
    test_step.dependOn(&run_lib_tests.step);

    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });
    const wasm_exe = b.addExecutable(.{
        .name = "luv_core",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/lib.zig"),
            .target = wasm_target,
            .optimize = .ReleaseSmall,
        }),
    });
    wasm_exe.entry = .disabled;
    wasm_exe.rdynamic = true;
    const wasm_install = b.addInstallArtifact(wasm_exe, .{
        .dest_dir = .{ .override = .{ .custom = "wasm" } },
    });
    const wasm_step = b.step("wasm", "Build wasm32-freestanding library");
    wasm_step.dependOn(&wasm_install.step);

    const check_step = b.step("check", "Type-check without codegen");
    check_step.dependOn(&exe.step);
    check_step.dependOn(&wasm_exe.step);

    const luv_mod = b.createModule(.{
        .root_source_file = b.path("src/morphisms/luv/luv.zig"),
        .target = target,
        .optimize = optimize,
    });
    const gen_ts = b.addExecutable(.{
        .name = "gen_ts_types",
        .root_module = b.createModule(.{
            .root_source_file = b.path("tools/gen_ts_types.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    gen_ts.root_module.addImport("luv", luv_mod);
    const run_gen_ts = b.addRunArtifact(gen_ts);
    run_gen_ts.addArg("../lib/js/src/types.generated.ts");
    const gen_ts_step = b.step("gen-ts", "Generate lib/js/src/types.generated.ts from luv.zig");
    gen_ts_step.dependOn(&run_gen_ts.step);

    // gen_sdk: abi.zig descriptor -> the mechanical wasm loader.
    const abi_mod = b.createModule(.{
        .root_source_file = b.path("src/wasm_abi/abi.zig"),
        .target = target,
        .optimize = optimize,
    });
    const gen_sdk = b.addExecutable(.{
        .name = "gen_sdk",
        .root_module = b.createModule(.{
            .root_source_file = b.path("tools/gen_sdk.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    gen_sdk.root_module.addImport("abi", abi_mod);
    const run_gen_sdk = b.addRunArtifact(gen_sdk);
    const gen_sdk_step = b.step("gen-sdk", "Generate lib/js/src/wasm/loader.generated.ts from abi.zig");
    gen_sdk_step.dependOn(&run_gen_sdk.step);
    gen_ts_step.dependOn(&run_gen_sdk.step);

    const fmt = b.addFmt(.{
        .paths = &.{ "src", "build.zig", "tools" },
        .check = true,
    });
    const fmt_step = b.step("fmt", "Check formatting");
    fmt_step.dependOn(&fmt.step);
}
