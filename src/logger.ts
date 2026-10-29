// JSON lines on stderr, so stdout stays clean for the CLI's own output.
export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
};

export function createLogger(base: Record<string, unknown> = {}): Logger {
  const write = (level: string, event: string, fields: Record<string, unknown> = {}) => {
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...base, ...fields })}\n`);
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
  };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {} };
