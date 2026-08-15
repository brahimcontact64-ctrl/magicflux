import 'server-only';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = {
  correlation_id?: string | null;
  execution_id?: string | null;
  worker_id?: string | null;
  user_id?: string | null;
  queue?: string;
  job_id?: string | number;
  workflow_id?: string | null;
  [key: string]: unknown;
};

type LogEntry = {
  level: LogLevel;
  event: string;
  ts: string;
} & LogContext;

function emit(level: LogLevel, event: string, ctx?: LogContext): void {
  const entry: LogEntry = {
    level,
    event,
    ts: new Date().toISOString(),
    ...ctx,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    // info and debug both go to stdout
    console.log(line);
  }
}

export const logger = {
  debug: (event: string, ctx?: LogContext) => emit('debug', event, ctx),
  info:  (event: string, ctx?: LogContext) => emit('info',  event, ctx),
  warn:  (event: string, ctx?: LogContext) => emit('warn',  event, ctx),
  error: (event: string, ctx?: LogContext) => emit('error', event, ctx),
};
