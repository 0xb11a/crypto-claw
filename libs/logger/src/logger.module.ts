import { Module, Global, DynamicModule } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { pinoRedactConfig } from './redactor.js';

/**
 * Config slice required by LoggerModule.
 *
 * Only the two fields that drive pino behaviour are declared here,
 * keeping the surface minimal and decoupled from the full AppConfig shape.
 */
export interface LoggerModuleConfig {
  /** Pino log level — must be a valid pino level string. */
  logLevel: string;
  /** Runtime environment — controls pino-pretty transport selection. */
  nodeEnv: string;
}

/**
 * Global NestJS logger module.
 *
 * Wraps nestjs-pino with CryptoClaw-specific redaction and request-id
 * propagation. Import once in AppModule via LoggerModule.forRoot(config);
 * do not import in feature modules.
 *
 * SPEC §11 — structured JSON via nestjs-pino; request-id propagation;
 * redaction; one log line per request.
 *
 * The config parameter is the resolved AppConfig slice (or equivalent),
 * removing all direct process.env reads from this file (SPEC §4 #6).
 */
@Global()
@Module({})
export class LoggerModule {
  /**
   * Configure the global logger.
   *
   * @param config - Resolved config containing logLevel and nodeEnv.
   *   Typically sourced from assertConfigValid(process.env) in each app's
   *   AppModule, which is cheap and idempotent to call more than once.
   */
  static forRoot(config: LoggerModuleConfig): DynamicModule {
    return {
      module: LoggerModule,
      global: true,
      imports: [
        PinoLoggerModule.forRoot({
          pinoHttp: {
            autoLogging: true,
            redact: pinoRedactConfig,
            level: config.logLevel,
            transport:
              config.nodeEnv !== 'production'
                ? { target: 'pino-pretty', options: { colorize: true } }
                : undefined,
            genReqId: (req) => {
              // Propagate x-request-id if present; otherwise generate one.
              const existing = (req.headers as Record<string, string | undefined>)['x-request-id'];
              if (existing) return existing;
              return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            },
            serializers: {
              req(req: { method: string; url: string; id: string }) {
                return { method: req.method, url: req.url, id: req.id };
              },
            },
          },
        }),
      ],
      exports: [PinoLoggerModule],
    };
  }
}
