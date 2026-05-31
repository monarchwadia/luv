FROM mcr.microsoft.com/devcontainers/javascript-node:24-trixie

USER vscode
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://bun.com/install | bash
# Bun's installer adds ~/.bun/bin to .bashrc only; export here for non-interactive shells (CI, Codespaces tasks).
ENV PATH="/home/vscode/.bun/bin:${PATH}"