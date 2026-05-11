FROM mcr.microsoft.com/devcontainers/rust:2-1-trixie

# Zig 0.16.0 for the core/ wasm build + tests.
USER root
ARG ZIG_VERSION=0.16.0
RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz" \
    | tar -xJ -C /opt \
 && mv "/opt/zig-x86_64-linux-${ZIG_VERSION}" /opt/zig \
 && ln -s /opt/zig/zig /usr/local/bin/zig

USER vscode
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://bun.com/install | bash
# Bun's installer adds ~/.bun/bin to .bashrc only; export here for non-interactive shells (CI, Codespaces tasks).
ENV PATH="/home/vscode/.bun/bin:${PATH}"