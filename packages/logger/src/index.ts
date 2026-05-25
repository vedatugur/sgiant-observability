import pino, { Logger as PinoLogger, LoggerOptions } from "pino";

const isDev = process.env.NODE_ENV !== "production";

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
        singleLine: false,
      },
    },
  }),
};

/**
 * Returns a pino child logger labelled with a service name.
 * Use the same logger across HTTP frameworks (Fastify) and standalone scripts.
 */
export function createAppLogger(service: string): PinoLogger {
  return pino(baseOptions).child({ service });
}

/**
 * Raw pino options — pass to Fastify so its HTTP logs share the same
 * pretty transport in dev and JSON output in prod.
 */
export const loggerOptions = baseOptions;

export type Logger = PinoLogger;
