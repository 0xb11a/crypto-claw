FROM ghcr.io/openclaw/openclaw:latest

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
  ${OPENCLAW_HOME}/agents/research/agent \
  ${OPENCLAW_HOME}/agents/research/data \
  ${OPENCLAW_HOME}/agents/sentinel/workspace/memory \
  ${OPENCLAW_HOME}/agents/sentinel/workspace/skills \
  ${OPENCLAW_HOME}/agents/sentinel/agent \
  ${OPENCLAW_HOME}/agents/executor/workspace/memory \
  ${OPENCLAW_HOME}/agents/executor/workspace/skills \
  ${OPENCLAW_HOME}/agents/executor/agent

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
