'use strict';

/**
 * Example ecosystem file. Note that both PM2's snake_case keys and camelCase
 * are accepted, and that `script` is resolved relative to this file.
 */
module.exports = {
  apps: [
    {
      name: 'eco-web',
      script: './app.js',
      cwd: __dirname,
      args: '--label eco',
      max_memory_restart: '300M',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
      // Bound the log files without an external logrotate module.
      log_rotate_size: '10M',
      log_rotate_keep: 5,
      log_rotate_compress: true
    },
    {
      name: 'eco-api',
      script: './http.js',
      exec_mode: 'cluster',
      instances: 2,
      args: ['--port', '4830'],
      env: { GREETING: 'hello', NODE_ENV: 'development' },
      env_production: { GREETING: 'hello-prod' },
      namespace: 'eco',
      // Wait for `process.send('ready')` before `start` returns.
      wait_ready: true,
      // One log file per worker, tagged as `eco-api | [0] ...` by `logs`.
      merge_logs: false
    }
  ]
};
