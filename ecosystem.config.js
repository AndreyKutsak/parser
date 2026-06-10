module.exports = {
  apps: [
    {
      name: 'app',
      script: 'src/app.js',
      node_args: '--max-old-space-size=512',
      max_memory_restart: '600M',
      autorestart: true,
      exp_backoff_restart_delay: 200,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'parser.worker',
      script: 'src/queue/workers/parser.worker.js',
      node_args: '--max-old-space-size=768',
      max_memory_restart: '900M',
      autorestart: true,
      exp_backoff_restart_delay: 200,
      env: { NODE_ENV: 'production' },
    },
  ],
};
