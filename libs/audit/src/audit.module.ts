import { Module, Global } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';
import { AuditInterceptor } from './audit.interceptor.js';

/**
 * Global audit module (SPEC §9.5, ADR-0018).
 *
 * Provides AuditRepository, AuditService, and AuditInterceptor.
 * Binds AuditInterceptor as a global APP_INTERCEPTOR so it runs on every
 * request, but the actual audit-row write only happens for handlers tagged
 * with @Audited() (the interceptor reads the metadata internally).
 *
 * Import once in AppModule. Do not import in feature modules.
 */
@Global()
@Module({
  providers: [AuditRepository, AuditService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  exports: [AuditService, AuditRepository],
})
export class AuditModule {}
