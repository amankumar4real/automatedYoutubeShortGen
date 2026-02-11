import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const message = err.message || 'Internal server error';
  const status = (res as { statusCode?: number }).statusCode && res.statusCode >= 400 ? res.statusCode : 500;
  if (res.headersSent) return;
  res.status(status);

  logger.error('Request error', err, { status, path: _req.path });

  res.status(status).json({
    error: config.isProd && status === 500 ? 'Internal server error' : message
  });
}
