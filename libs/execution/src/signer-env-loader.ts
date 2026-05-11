/**
 * signer-env-loader.ts — Reads `secrets/signer.env` and returns signer keys.
 *
 * Per ADR-0023:
 *   - Reads the file via `fs.readFileSync` (NOT dotenv — avoids side-effect
 *     writes to process.env).
 *   - Validates file mode is 0400 or 0600 (0600 accepted: some filesystems
 *     normalize, and macOS bind-mounts can't achieve 0400 from compose).
 *   - Fails hard in NODE_ENV=production if mode check fails.
 *   - Warns only in development (SPEC §9.7).
 *   - Returns `{ SAFE_SIGNER_KEY, SQUADS_SIGNER_KEY }` as plain strings.
 *     Missing keys are empty strings (executor validates presence itself).
 *
 * SPEC §4 #4 — signer keys never appear in process.env.
 * ADR-0023 — signer env file mount pattern.
 */
import { readFileSync, statSync } from 'node:fs';

/** Shape returned by loadSignerEnv. */
export interface SignerEnv {
  /** Raw hex private key for the Safe signer (EVM). Empty if not set. */
  SAFE_SIGNER_KEY: string;
  /** Base58-encoded Solana keypair for Squads. Empty if not set. */
  SQUADS_SIGNER_KEY: string;
}

/**
 * Parse a `KEY=value` env file into a plain string record.
 * Blank lines and `#` comments are ignored.
 * Values may optionally be quoted with single or double quotes.
 */
function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // Strip optional surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Load signer keys from the env file at `filePath`.
 *
 * @param filePath - Absolute path to the signer env file (e.g. /run/secrets/signer.env).
 * @param nodeEnv - NODE_ENV value; 'production' triggers hard-fail on mode check.
 * @throws {Error} in production if the file mode is not 0400/0600 (world-readable).
 * @throws {Error} if the file cannot be read.
 * @returns SignerEnv — parsed signer keys (empty string if not set in file).
 */
export function loadSignerEnv(filePath: string, nodeEnv = 'development'): SignerEnv {
  // ---------------------------------------------------------------------------
  // Step 1: check file mode
  // ---------------------------------------------------------------------------
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch (err) {
    throw new Error(`[signer-env-loader] cannot stat ${filePath}: ${String(err)}`);
  }

  const mode = stat.mode & 0o777;
  const isWorldReadable = (mode & 0o007) !== 0;
  const isGroupReadable = (mode & 0o070) !== 0;

  if (isWorldReadable || (isGroupReadable && mode !== 0o640)) {
    const modeStr = mode.toString(8).padStart(4, '0');
    const msg = `[signer-env-loader] ${filePath} has insecure mode 0${modeStr} (expected 0400 or 0600)`;
    if (nodeEnv === 'production') {
      throw new Error(msg);
    }
    // Development/test: warn loudly but continue
    process.stderr.write(`[WARN] ${msg} — proceeding in non-production mode\n`);
  }

  // ---------------------------------------------------------------------------
  // Step 2: read and parse
  // ---------------------------------------------------------------------------
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`[signer-env-loader] cannot read ${filePath}: ${String(err)}`);
  }

  const parsed = parseEnvFile(contents);

  return {
    SAFE_SIGNER_KEY: parsed['SAFE_SIGNER_KEY'] ?? '',
    SQUADS_SIGNER_KEY: parsed['SQUADS_SIGNER_KEY'] ?? '',
  };
}
