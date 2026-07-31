module.exports = {
  apps: [
    {
      name: 'app',
      script: 'src/app.js',
      // Hit real V8 heap OOM in prod at 256MB (2026-07-30) — host cgroup limit is
      // actually 16GB (shared HestiaCP box), so there's plenty of headroom to raise this.
      node_args: '--max-old-space-size=512',
      max_memory_restart: '700M',
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
      // Host has ~2GB RAM total — lower concurrency instead of raising the heap cap
      // (was 5/2, hit JS heap OOM under load). Puppeteer/Chromium is the heaviest
      // per-job consumer, so dynamic concurrency is capped at 1.
      env: {
        NODE_ENV: 'production',
        MAX_CONCURRENT_TASKS: '3',
        MAX_CONCURRENT_DYNAMIC_TASKS: '1',
      },
    },
  ],
};
