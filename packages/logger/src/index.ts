import {
  createLogger,
  format,
  transports,
  Logger as WinstonLogger,
} from "winston";

export function createAppLogger(service: string): WinstonLogger {
  return createLogger({
    level: process.env.LOG_LEVEL ?? "info",
    defaultMeta: { service },
    format: format.combine(
      format.colorize(),
      format.timestamp(),
      format.printf(({ timestamp, level, message, service: svc }) => {
        return `${timestamp} [${svc}] ${level}: ${message}`;
      })
    ),
    transports: [new transports.Console()],
  });
}

export type { WinstonLogger as Logger };
