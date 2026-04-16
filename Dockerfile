FROM ghcr.io/openclaw/openclaw:2026.4.12

# Install jq (agents use it to parse JSON script output) and gh (GitHub CLI for Observer agent)
USER root
RUN apt-get update -qq && apt-get install -y -qq jq > /dev/null 2>&1 && rm -rf /var/lib/apt/lists/* && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update -qq && apt-get install -y -qq gh > /dev/null 2>&1 && rm -rf /var/lib/apt/lists/*

# Install node-llama-cpp for local embeddings (memory search)
# Installed in isolation to avoid peer dep conflicts with /app's dependency tree,
# then linked into /app/node_modules so OpenClaw's engine-embeddings can resolve it
RUN npm install -g node-llama-cpp@3.18.1 --cache /tmp/npm-cache && \
    ln -s "$(npm root -g)/node-llama-cpp" /app/node_modules/node-llama-cpp && \
    rm -rf /tmp/npm-cache

# Workaround: /home/node is read-only at runtime. Pre-create dirs that tools need:
# - QQBot plugin crashes without its data dir (even when unconfigured)
# - gh CLI needs ~/.config/gh/ to store auth tokens
# - node-llama-cpp uses os.homedir()/.node-llama-cpp (hardcoded, no env override)
RUN mkdir -p /home/node/.openclaw/qqbot/data /home/node/.config/gh /home/node/.node-llama-cpp && chown -R 1000:1000 /home/node/.openclaw /home/node/.config /home/node/.node-llama-cpp

# Run as non-root for security
USER 1000:1000

# Set workspace directory
ENV OPENCLAW_HOME=/home/openclaw/.openclaw
WORKDIR /home/openclaw

# Copy CryptoClaw project
COPY --chown=1000:1000 . /home/openclaw/crypto-claw

# Install script dependencies once (shared via symlink at runtime)
# npm rebuild ensures native modules (better-sqlite3) are compiled for the container platform
RUN cd /home/openclaw/crypto-claw/scripts && npm install --omit=dev && npm rebuild

# Create agent directories matching OpenClaw's expected structure
RUN mkdir -p \
  ${OPENCLAW_HOME}/agents/research/workspace/memory \
  ${OPENCLAW_HOME}/agents/research/workspace/skills \
  ${OPENCLAW_HOME}/agents/research/workspace/scripts \
  ${OPENCLAW_HOME}/agents/research/agent \
  ${OPENCLAW_HOME}/agents/research/data \
  ${OPENCLAW_HOME}/agents/sentinel/workspace/memory \
  ${OPENCLAW_HOME}/agents/sentinel/workspace/skills \
  ${OPENCLAW_HOME}/agents/sentinel/agent \
  ${OPENCLAW_HOME}/agents/executor/workspace/memory \
  ${OPENCLAW_HOME}/agents/executor/workspace/skills \
  ${OPENCLAW_HOME}/agents/executor/agent \
  ${OPENCLAW_HOME}/agents/observer/workspace/memory \
  ${OPENCLAW_HOME}/agents/observer/workspace/skills \
  ${OPENCLAW_HOME}/agents/observer/agent

# Build workspace and agent templates (replaces setup.sh --docker)
RUN chmod +x /home/openclaw/crypto-claw/build-templates.sh && \
    /home/openclaw/crypto-claw/build-templates.sh

# Pre-create the OpenClaw state dir so Docker volumes inherit UID 1000 ownership
RUN mkdir -p ${OPENCLAW_HOME}/.openclaw

# Runtime entrypoint: syncs templates, registers agents, runs DB migrations, starts gateway
COPY --chown=1000:1000 entrypoint.sh /home/openclaw/entrypoint.sh
RUN chmod +x /home/openclaw/entrypoint.sh

# Expose default gateway port
EXPOSE 18789

# Healthcheck uses the gateway port from env (default 18789)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:${OPENCLAW_GATEWAY_PORT:-18789}/health || exit 1

ENTRYPOINT ["/home/openclaw/entrypoint.sh"]
