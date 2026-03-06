FROM ghcr.io/openclaw/openclaw:latest

# Run as non-root for security
USER 1000:1000

# Set workspace directory
ENV OPENCLAW_HOME=/home/openclaw/.openclaw
WORKDIR /home/openclaw

# Copy CryptoClaw project
COPY --chown=1000:1000 . /home/openclaw/crypto-claw

# Install script dependencies
RUN cd /home/openclaw/crypto-claw/scripts && npm install --omit=dev

# Bootstrap script copies files to the right places
COPY --chown=1000:1000 setup.sh /home/openclaw/setup.sh
RUN chmod +x /home/openclaw/setup.sh

# Create agent directories (all three agents)
RUN mkdir -p \
  ${OPENCLAW_HOME}/agents/research/workspace/memory \
  ${OPENCLAW_HOME}/agents/research/skills \
  ${OPENCLAW_HOME}/agents/research/data \
  ${OPENCLAW_HOME}/agents/sentinel/workspace/memory \
  ${OPENCLAW_HOME}/agents/sentinel/skills \
  ${OPENCLAW_HOME}/agents/executor/workspace/memory \
  ${OPENCLAW_HOME}/agents/executor/skills

# Run setup to deploy agents into OpenClaw (directories, agent configs, scripts)
ARG SAFE_ID=default
ENV SAFE_ID=${SAFE_ID}
RUN /home/openclaw/setup.sh --docker

# Bake code-owned workspace files into templates directory
# entrypoint.sh syncs these into the volume on every container start,
# so code updates survive redeploys even when volumes persist
RUN mkdir -p /home/openclaw/workspace-templates
COPY --chown=1000:1000 workspace/TOOLS.md     /home/openclaw/workspace-templates/TOOLS.md
COPY --chown=1000:1000 workspace/BOOT.md      /home/openclaw/workspace-templates/BOOT.md
COPY --chown=1000:1000 workspace/IDENTITY.md  /home/openclaw/workspace-templates/IDENTITY.md
COPY --chown=1000:1000 workspace/USER.md      /home/openclaw/workspace-templates/USER.md
COPY --chown=1000:1000 workspace/MEMORY.md    /home/openclaw/workspace-templates/MEMORY.md

# Runtime entrypoint: syncs templates into volume, runs DB migrations, starts gateway
COPY --chown=1000:1000 entrypoint.sh /home/openclaw/entrypoint.sh
RUN chmod +x /home/openclaw/entrypoint.sh

# Expose gateway port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:3000/health || exit 1

ENTRYPOINT ["/home/openclaw/entrypoint.sh"]
