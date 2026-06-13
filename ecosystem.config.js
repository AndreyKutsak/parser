module.exports = {
  apps: [
    {
      name: 'app',
      script: 'src/app.js',
      // After scheduler→queue fix the app only runs Express + queue client, ~100-150MB
      node_args: '--max-old-space-size=256',
      max_memory_restart: '350M',
      autorestart: true,
      exp_backoff_restart_delay: 200,
      min_uptime: '10s',   // don't count as crashed if it stays up ≥10s
      max_restarts: 20,
      kill_timeout: 5000,  // give 5s for graceful shutdown before SIGKILL
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'parser.worker',
      script: 'src/queue/workers/parser.worker.js',
      // 8 concurrent cheerio parses + Puppeteer pool; keep headroom for spikes
      node_args: '--max-old-space-size=512',
      max_memory_restart: '650M',
      autorestart: true,
      exp_backoff_restart_delay: 200,
      min_uptime: '10s',
      max_restarts: 20,
      kill_timeout: 35000, // worker needs 30s for graceful job drain + 5s buffer
      env: { NODE_ENV: 'production' },
    },
  ],
};
