import { Module, Global } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { pinoRedactConfig } from './redactor.js';

/**
 * Global NestJS logger module.
 *
 * Wraps nestjs-pino with CryptoClaw-specific redaction and request-id
 * propagation. Import once in AppModule; do not import in feature modules.
 *
 * SPEC §11 — structured JSON via nestjs-pino; request-id propagation;
 * redaction; one log line per request.
 */
@Global()
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        autoLogging: true,
        redact: pinoRedactConfig,
        level: process.env['LOG_LEVEL'] ?? 'info',
        transport:
          process.env['NODE_ENV'] !== 'production'
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
})
export class LoggerModule {}
