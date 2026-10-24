/** Structured log fields. Never include a token, key, or webhook secret. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, fields: LogFields): void;
  warn(message: string, fields: LogFields): void;
  error(message: string, fields: LogFields): void;
}

/** Writes one JSON line per entry, the shape the host's log search indexes. */
export function createJsonLogger(write: (line: string) => void): Logger {
  const entry =
    (level: 'info' | 'warn' | 'error') =>
    (message: string, fields: LogFields): void => {
      write(JSON.stringify({ level, message, ...fields }));
    };
  return { info: entry('info'), warn: entry('warn'), error: entry('error') };
}
