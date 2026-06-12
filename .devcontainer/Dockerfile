FROM mcr.microsoft.com/devcontainers/javascript-node:24-trixie

USER node

# Temporarily disable for corporate
# RUN echo "insecure" > ~/.curlrc

RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://bun.com/install | bash
RUN curl -fsSL https://cli.kiro.dev/install | bash

# Bun's installer adds ~/.bun/bin to .bashrc only; export here for non-interactive shells (CI, Codespaces tasks).
ENV PATH="/home/node/.bun/bin:${PATH}"