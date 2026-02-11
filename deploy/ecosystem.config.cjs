/** PM2 process file for shorts API. Run from repo root: pm2 start deploy/ecosystem.config.cjs */
module.exports = {
  apps: [
    {
      name: 'shorts-api',
      script: 'backend/server.js',
      cwd: process.cwd(),
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
