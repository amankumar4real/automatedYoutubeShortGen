import app from './app';
import { config } from './config';
import { getDb, closeDb } from './db';
import { logger } from './logger';

async function main(): Promise<void> {
  try {
    await getDb();
  } catch (err) {
    logger.warn('MongoDB not connected at startup', { message: (err as Error).message });
  }

  const server = app.listen(config.port, () => {
    logger.info(`Listening on http://localhost:${config.port}`, { env: config.env });
  });

  const shutdown = (signal: string) => () => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Server failed to start', err);
  process.exit(1);
});
