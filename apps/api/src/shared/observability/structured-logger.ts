import { LoggerService, LogLevel } from '@nestjs/common';
import { getTraceContext } from './trace-context';
import { getRequestContext } from '@shared/tenant';

/**
 * Cycle 31 Step 1 — Structured JSON Logger (Architecture Review §25.2).
 *
 * Replaces NestJS's default ConsoleLogger with a JSON-emitting one
 * that reads the trace + tenant context from AsyncLocalStorage.
 *
 * Required fields (per Architecture Review §25.2):
 *   timestamp, level, service_name, trace_id, span_id, tenant_id,
 *   message
 *
 * Conditional fields:
 *   user_id, event_type (consumer log lines), worker_name,
 *   duration_ms, error_code, module (NestJS context name)
 *
 * PII contract: only IDs, no names / emails / free-text personal
 * data. The log-schema-lint script in tools/lint-log-schema.ts
 * scans the codebase for forbidden patterns (raw email regex,
 * stack traces in `message`).
 *
 * In dev/test the output is single-line JSON to stdout. In
 * production, CloudWatch Logs / ELK consume the same stream.
 *
 * The logger is enabled by setting `useLogger(new
 * StructuredLogger())` in main.ts before NestFactory boot.
 */
export class StructuredLogger implements LoggerService {
  private static readonly LEVELS: LogLevel[] = ['log', 'error', 'warn', 'debug', 'verbose'];

  private readonly serviceName: string;
  private enabledLevels: Set<LogLevel>;

  constructor(options?: { serviceName?: string; levels?: LogLevel[] }) {
    this.serviceName = options?.serviceName ?? process.env.SERVICE_NAME ?? 'campusos-api';
    const levels = options?.levels ?? StructuredLogger.LEVELS;
    this.enabledLevels = new Set(levels);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.enabledLevels = new Set(levels);
  }

  log(message: unknown, context?: string): void {
    if (this.enabledLevels.has('log')) this.write('INFO', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    if (!this.enabledLevels.has('error')) return;
    this.write('ERROR', message, context, stack);
  }

  warn(message: unknown, context?: string): void {
    if (this.enabledLevels.has('warn')) this.write('WARN', message, context);
  }

  debug(message: unknown, context?: string): void {
    if (this.enabledLevels.has('debug')) this.write('DEBUG', message, context);
  }

  verbose(message: unknown, context?: string): void {
    if (this.enabledLevels.has('verbose')) this.write('TRACE', message, context);
  }

  private write(level: string, message: unknown, context?: string, stack?: string): void {
    const trace = getTraceContext();
    const reqCtx = getRequestContext();
    const tenantId = reqCtx?.tenant?.schoolId ?? null;
    const userId = reqCtx?.userId ?? null;

    let messageText: string;
    let extra: Record<string, unknown> | undefined;
    if (typeof message === 'string') {
      messageText = message;
    } else if (message && typeof message === 'object') {
      const obj = message as Record<string, unknown>;
      messageText = typeof obj.message === 'string' ? obj.message : JSON.stringify(message);
      const { message: _msg, ...rest } = obj;
      void _msg;
      if (Object.keys(rest).length > 0) extra = rest;
    } else {
      messageText = String(message);
    }

    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      service_name: this.serviceName,
      trace_id: trace?.traceId ?? null,
      span_id: trace?.spanId ?? null,
      tenant_id: tenantId,
      message: messageText,
    };
    if (context) record.module = context;
    if (userId) record.user_id = userId;
    if (extra) Object.assign(record, extra);
    // NB: stack traces are emitted as a separate field so the message
    // field stays clean for log search. Architecture Review §25.2.
    if (stack) record.stack = stack;

    // The structured log line is a single JSON object on a line so
    // CloudWatch / ELK / Loki can ingest it without parsing.
    process.stdout.write(JSON.stringify(record) + '\n');
  }
}
