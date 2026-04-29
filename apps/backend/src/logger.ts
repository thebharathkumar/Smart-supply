import pino from 'pino';
import type { AppConfig } from './config.js';

export function createLogger(cfg: AppConfig) {
  return pino({
    level: cfg.LOG_LEVEL,
    base: { service: 'backend' },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      cfg.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
