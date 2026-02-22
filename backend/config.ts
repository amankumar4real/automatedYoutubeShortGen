/**
 * Central config from environment. Validates required vars in production.
 */
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

function env(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (isProd && (value === undefined || value === '')) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value ?? '';
}

export const config = {
  env: NODE_ENV,
  isProd,

  port: parseInt(process.env.PORT || '4000', 10),

  mongodb: {
    // In development, "mongo" host only resolves inside Docker; use localhost when running on host
    uri: (() => {
      let uri = env('MONGODB_URI', 'mongodb://localhost:27017');
      if (NODE_ENV !== 'production' && uri.includes('mongo')) {
        uri = uri.replace('//mongo:', '//localhost:').replace('@mongo:', '@localhost:');
      }
      return uri;
    })(),
    dbName: env('MONGODB_DB_NAME', 'shorts')
  },

  jwt: {
    secret: env('JWT_SECRET', 'change-me-in-production'),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName: process.env.R2_BUCKET_NAME
  },

  /** Base path for temp and output (defaults to cwd) */
  workspaceRoot: process.cwd()
} as const;

export type Config = typeof config;
