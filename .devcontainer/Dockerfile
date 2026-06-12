FROM mcr.microsoft.com/devcontainers/javascript-node:24-trixie

USER node

# Temporarily disable for corporate
# RUN echo "insecure" > ~/.curlrc

RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://bun.com/install | bash
RUN curl -fsSL https://cli.kiro.dev/install | bash

# gh cli

RUN (type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
	&& sudo mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& sudo apt update \
	&& sudo apt install gh -y

# Bun's installer adds ~/.bun/bin to .bashrc only; export here for non-interactive shells (CI, Codespaces tasks).
ENV PATH="/home/node/.bun/bin:${PATH}"