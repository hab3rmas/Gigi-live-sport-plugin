// pm2 config for a single-instance deployment.
//
// The upstream config ran 2 workers in cluster mode. For a personal / small
// instance a single process is faster and more predictable: one manifest
// cache instead of two (fewer upstream playlist fetches, consistent live edge),
// no cross-worker disk polling of the match cache, no HTTP L2 hop for the
// resolve cache. CPU-heavy extractors already run in separate child processes
// (bounded by CHILD_PROC_MAX).
module.exports = {
  apps: [
    {
      name: 'nuvio-sports',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1300M',
      kill_timeout: 12000, // let the graceful drain finish (SHUTDOWN_GRACE_MS)
      node_args: '--expose-gc',
      env: {
        NODE_ENV: 'production',
        MALLOC_ARENA_MAX: '2',
        UV_THREADPOOL_SIZE: '16',
        PREWARM_MAX_MATCHES: '12',
        PREWARM_CRON_SCHEDULE: '*/3 * * * *',
      }
    }
  ]
};
