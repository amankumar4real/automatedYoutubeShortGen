import { config } from './config';

const prefix = '[shorts]';

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => {
    const payload = meta ? ` ${JSON.stringify(meta)}` : '';
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${msg}${payload}`);
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    const payload = meta ? ` ${JSON.stringify(meta)}` : '';
    // eslint-disable-next-line no-console
    console.warn(`${prefix} ${msg}${payload}`);
  },
  error: (msg: string, err?: unknown, meta?: Record<string, unknown>) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    const payload = meta ? { ...meta, error: errMsg } : { error: errMsg };
    // eslint-disable-next-line no-console
    console.error(`${prefix} ${msg}`, payload);
    if (err instanceof Error && !config.isProd) {
      // eslint-disable-next-line no-console
      console.error(err.stack);
    }
  }
};
