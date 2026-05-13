#!/usr/bin/env node
/**
 * Minimal healthcheck script for Docker HEALTHCHECK.
 *
 * TODO P1: replace with an HTTP probe against GET /healthz once
 * @nestjs/terminus is wired in.
 *
 * For now, exits 0 unconditionally so the compose stack reaches
 * healthy state and worker/scheduler can depend on it.
 */
process.exit(0);
