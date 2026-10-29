/* Admin console fixtures. Field names follow the real payloads in
   backend/app/api/v1/app_controller.py, agent_admin_controller.py,
   search_admin_controller.py and redis_admin_service.py so the prototype
   can be checked against the API without translating shapes. */
window.KustosAdminData = (function () {
  "use strict";

  const INSTANCE = {
    name: "Northstar Labs",
    host: "kustos.meridian.dev",
    version: "1.0.0",
    debug_mode: false,
    uptime_seconds: 533412,
    uptime_formatted: "6d 4h 10m",
    server_time: "2026-10-28T15:12:04+08:00",
    process: { pid: 41, memory_mb: 612.4, cpu_percent: 7.8, threads: 38, connections: 214 },
    requests: {
      total: 1284930, success: 1271104, failed: 13826,
      avg_response_time_ms: 118, requests_per_minute: 412
    },
    git_operations: { active_clones: 3, active_pushes: 1, queue_size: 0 },
    schema_state: { applied: "9f2c41ab7d10", head: "9f2c41ab7d10" }
  };

  const COMPONENT_GROUPS = [
    { key: "edge", label: "Edge" },
    { key: "app", label: "Application" },
    { key: "git", label: "Git access" },
    { key: "data", label: "Data" },
    { key: "control", label: "Control plane" },
    { key: "observe", label: "Observability", optional: true },
    { key: "job", label: "One-shot" }
  ];

  const COMPONENTS = [
    {
      service: "gateway", label: "OpenResty gateway", group: "edge", state: "running",
      health: "healthy", running: true, image: "kustos/gateway:1.0.0",
      started_at: "2026-10-22T10:58:02Z", uptime_seconds: 533402, restart_count: 0,
      exit_code: null, ports: "0.0.0.0:8000→80", status_text: "Up 6 days (healthy)"
    },
    {
      service: "app", label: "FastAPI app", group: "app", state: "running",
      health: "healthy", running: true, image: "kustos/app:1.0.0",
      started_at: "2026-10-22T10:58:19Z", uptime_seconds: 533385, restart_count: 0,
      exit_code: null, ports: "8000/tcp", status_text: "Up 6 days (healthy) · 4 workers"
    },
    {
      service: "agent-worker", label: "arq agent worker", group: "app", state: "running",
      health: null, running: true, image: "kustos/app:1.0.0",
      started_at: "2026-10-28T13:00:41Z", uptime_seconds: 7860, restart_count: 1,
      exit_code: null, ports: "—", status_text: "Up 2 hours · restarted after deploy"
    },
    {
      service: "collab", label: "Hocuspocus gateway", group: "app", state: "running",
      health: "healthy", running: true, image: "kustos/collab:1.0.0",
      started_at: "2026-10-22T10:58:27Z", uptime_seconds: 533377, restart_count: 0,
      exit_code: null, ports: "4444, 4445", status_text: "Up 6 days (healthy)"
    },
    {
      service: "git-cgi", label: "git-http-backend", group: "git", state: "running",
      health: "healthy", running: true, image: "kustos/git-cgi:1.0.0",
      started_at: "2026-10-22T10:58:33Z", uptime_seconds: 533371, restart_count: 0,
      exit_code: null, ports: "9000/tcp", status_text: "Up 6 days (healthy)"
    },
    {
      service: "sshd", label: "Git over SSH", group: "git", state: "running",
      health: null, running: true, image: "kustos/sshd:1.0.0",
      started_at: "2026-10-22T10:58:38Z", uptime_seconds: 533366, restart_count: 0,
      exit_code: null, ports: "2222→22", status_text: "Up 6 days"
    },
    {
      service: "postgres", label: "PostgreSQL + pgvector", group: "data", state: "running",
      health: "healthy", running: true, image: "pgvector/pgvector:pg16",
      started_at: "2026-10-22T10:56:11Z", uptime_seconds: 533513, restart_count: 0,
      exit_code: null, ports: "5432/tcp", status_text: "Up 6 days (healthy)"
    },
    {
      service: "redis", label: "Redis", group: "data", state: "running",
      health: "healthy", running: true, image: "redis:7.4-alpine",
      started_at: "2026-10-22T10:56:11Z", uptime_seconds: 533513, restart_count: 0,
      exit_code: null, ports: "6379/tcp", status_text: "Up 6 days (healthy)"
    },
    {
      service: "docker-socket-proxy", label: "Read-only socket proxy", group: "control",
      state: "running", health: null, running: true, image: "tecnativa/docker-socket-proxy:0.2",
      started_at: "2026-10-22T10:58:41Z", uptime_seconds: 533363, restart_count: 0,
      exit_code: null, ports: "2375/tcp", status_text: "Up 6 days · backs this page"
    },
    {
      service: "docker-write-proxy", label: "Narrow write proxy", group: "control",
      state: "running", health: null, running: true, image: "kustos/docker-write-proxy:1.0.0",
      started_at: "2026-10-22T10:58:43Z", uptime_seconds: 533361, restart_count: 0,
      exit_code: null, ports: "2375/tcp", status_text: "Up 6 days · monitoring start/stop only"
    },
    {
      service: "prometheus", label: "Prometheus", group: "observe", state: "exited",
      health: null, running: false, image: "prom/prometheus:v3.0.1",
      started_at: "2026-10-24T09:11:02Z", uptime_seconds: null, restart_count: 0,
      exit_code: 143, ports: "9090/tcp", status_text: "Exited (143) 4 days ago"
    },
    {
      service: "grafana", label: "Grafana", group: "observe", state: "exited",
      health: null, running: false, image: "grafana/grafana:11.3.0",
      started_at: "2026-10-24T09:11:02Z", uptime_seconds: null, restart_count: 0,
      exit_code: 143, ports: "3000/tcp", status_text: "Exited (143) 4 days ago"
    },
    {
      service: "init", label: "Migration + admin bootstrap", group: "job", state: "exited",
      health: null, running: false, image: "kustos/app:1.0.0",
      started_at: "2026-10-22T10:57:52Z", uptime_seconds: null, restart_count: 0,
      exit_code: 0, ports: "—", status_text: "Exited (0) 6 days ago"
    }
  ];

  const COMPONENT_SUMMARY = {
    total: 13, running: 10, stopped: 3, healthy: 6, unhealthy: 0, starting: 0
  };

  const MONITORING = {
    available: true,
    reason: null,
    generated_at: "2026-10-28T07:12:01Z",
    grafana: { running: false, configured: true, ready: false, entry: "/grafana", container_id: null },
    prometheus: { running: false, configured: true, ready: false, entry: "/prometheus", container_id: null }
  };

  const REDIS = {
    configured: true,
    reachable: true,
    latency_ms: 1.2,
    server: { version: "7.4.1", mode: "standalone", uptime_seconds: 533500, tcp_port: 6379 },
    memory: { used: 50541363, used_human: "48.2M", peak_human: "61.4M", maxmemory: 268435456, maxmemory_policy: "allkeys-lru" },
    clients: { connected: 12, blocked: 0, maxclients: 10000 },
    stats: { total_commands_processed: 18420031, keyspace_hits: 9120441, keyspace_misses: 340112, evicted_keys: 0, expired_keys: 41203 },
    workers: {
      expected: 4, alive: 4,
      items: [
        { pid: 41, uptime_seconds: 533385, jobs: 0 },
        { pid: 47, uptime_seconds: 533380, jobs: 1 },
        { pid: 52, uptime_seconds: 533374, jobs: 0 },
        { pid: 58, uptime_seconds: 533368, jobs: 1 }
      ]
    },
    pubsub: {
      pattern_subscriptions: 6, expected_workers: 4, bus_running_workers: 4,
      mismatch: false, channels: ["kustos:ws:broadcast", "kustos:ws:presence", "kustos:events"]
    },
    keyspace: [{ db: 0, keys: 1284, expires: 642, avg_ttl: "14m" }],
    degradation: {
      unavailable_returns: 0, connect_failures: 0, require_failures: 0,
      bus_running: true, bus_published: 18422, bus_publish_failures: 0,
      bus_received: 18422, bus_dispatch_failures: 0, bus_last_error: null, degraded: []
    }
  };

  /* Metrics are synthetic but shaped like MetricsTimeseriesResponse:
     points carry rpm / err_rate / avg_ms / p95_ms / mem_mb / cpu_pct and a
     status-code split. */
  const RANGES = {
    "5m": { step: 10, points: 30, label: "last 5 minutes" },
    "30m": { step: 60, points: 30, label: "last 30 minutes" },
    "1h": { step: 120, points: 30, label: "last hour" },
    "6h": { step: 720, points: 30, label: "last 6 hours" },
    "24h": { step: 2880, points: 30, label: "last 24 hours" }
  };

  function seedFrom(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function series(rangeKey) {
    const conf = RANGES[rangeKey] || RANGES["1h"];
    let seed = seedFrom(rangeKey + "kustos");
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const now = Date.now();
    const points = [];
    let mem = 598;
    for (let i = 0; i < conf.points; i += 1) {
      const wave = Math.sin(i / 3.4) * 46 + Math.sin(i / 1.7) * 18;
      const rpm = Math.max(86, 418 + wave + rand() * 44);
      const errRate = Math.max(0, 0.32 + Math.sin(i / 2.6) * 0.22 + rand() * 0.28);
      const avg = 102 + Math.sin(i / 4) * 16 + rand() * 22;
      mem = Math.max(560, Math.min(668, mem + (rand() - 0.46) * 9));
      const s5 = Math.round(rpm * errRate / 100 * conf.step / 60);
      const s4 = Math.round(rpm * (0.008 + rand() * 0.01) * conf.step / 60) + 1;
      const s3 = Math.round(rpm * 0.004 * conf.step / 60);
      const total = Math.max(2, Math.round(rpm * conf.step / 60));
      points.push({
        t: now - (conf.points - 1 - i) * conf.step * 1000,
        rpm: Math.round(rpm),
        err_rate: Number(errRate.toFixed(2)),
        avg_ms: Math.round(avg),
        p95_ms: Math.round(avg * 1.72 + 24),
        mem_mb: Math.round(mem * 10) / 10,
        cpu_pct: Math.round((4 + rand() * 7) * 10) / 10,
        s2xx: Math.max(0, total - s3 - s4 - s5),
        s3xx: s3, s4xx: s4, s5xx: s5
      });
    }
    return { range: rangeKey, step: conf.step, label: conf.label, source: "redis", points };
  }

  const ACL = {
    sources: ["10.20.0.0/16", "127.0.0.1/32"],
    updated_at: "2026-10-21",
    updated_by: "Lin Wei",
    gated_paths: ["^~ /api/app/", "= /grafana", "^~ /grafana/"],
    note: "KUSTOS_ADMIN_ALLOWED_SOURCES — empty means deny every source."
  };

  const USERS = [
    { id: "u-01", name: "Lin Wei", handle: "lin", email: "lin@northstar.dev", role: "admin", status: "active", last_active: "now", repos: 3, joined: "2025-03-11" },
    { id: "u-02", name: "Ada Okonkwo", handle: "ada", email: "ada@northstar.dev", role: "admin", status: "active", last_active: "2h ago", repos: 3, joined: "2025-04-02" },
    { id: "u-03", name: "Mara Voss", handle: "mara", email: "mara@northstar.dev", role: "member", status: "active", last_active: "2m ago", repos: 2, joined: "2025-05-19" },
    { id: "u-04", name: "Ilya Sokolov", handle: "ilya", email: "ilya@northstar.dev", role: "member", status: "active", last_active: "18m ago", repos: 2, joined: "2025-06-01" },
    { id: "u-05", name: "Noor Haddad", handle: "noor", email: "noor@northstar.dev", role: "member", status: "active", last_active: "41m ago", repos: 2, joined: "2025-07-23" },
    { id: "u-06", name: "Theo Marsh", handle: "theo", email: "theo@northstar.dev", role: "member", status: "active", last_active: "1h ago", repos: 1, joined: "2025-08-09" },
    { id: "u-07", name: "Priya Raman", handle: "priya", email: "priya@northstar.dev", role: "member", status: "active", last_active: "3h ago", repos: 2, joined: "2025-09-14" },
    { id: "u-08", name: "Jonas Keller", handle: "jonas", email: "jonas@northstar.dev", role: "member", status: "active", last_active: "yesterday", repos: 1, joined: "2025-10-02" },
    { id: "u-09", name: "Sofia Lindqvist", handle: "sofia", email: "sofia@northstar.dev", role: "member", status: "active", last_active: "yesterday", repos: 2, joined: "2025-11-18" },
    { id: "u-10", name: "Kenji Watanabe", handle: "kenji", email: "kenji@northstar.dev", role: "member", status: "disabled", last_active: "12d ago", repos: 1, joined: "2026-01-07" },
    { id: "u-11", name: "Amara Diallo", handle: "amara", email: "amara@northstar.dev", role: "member", status: "active", last_active: "4h ago", repos: 1, joined: "2026-02-11" },
    { id: "u-12", name: "Ruben Ortiz", handle: "ruben", email: "ruben@northstar.dev", role: "member", status: "active", last_active: "2d ago", repos: 1, joined: "2026-03-30" },
    { id: "u-13", name: "Hana Sato", handle: "hana", email: "hana@northstar.dev", role: "member", status: "active", last_active: "5h ago", repos: 2, joined: "2026-05-06" },
    { id: "u-14", name: "kustos-agent", handle: "kustos", email: "agent@northstar.dev", role: "member", status: "active", last_active: "1m ago", repos: 3, joined: "2026-06-19", bot: true }
  ];

  const CONFIG = [
    {
      name: "server", writable: true, hot: false,
      keys: [
        { key: "host", value: "0.0.0.0", source: "db", restart: true },
        { key: "port", value: "8000", source: "env", restart: true },
        { key: "log_level", value: "info", source: "db", restart: true },
        { key: "reload", value: "false", source: "default", restart: true, locked: true }
      ]
    },
    {
      name: "gunicorn", writable: true, hot: false,
      keys: [
        { key: "workers", value: "4", source: "db", restart: true },
        { key: "worker_class", value: "uvicorn.workers.UvicornWorker", source: "default", restart: true },
        { key: "timeout", value: "120", source: "default", restart: true },
        { key: "max_requests", value: "2000", source: "db", restart: true },
        { key: "max_requests_jitter", value: "200", source: "default", restart: true }
      ]
    },
    {
      name: "database", writable: true, hot: false,
      keys: [
        { key: "url", value: "postgresql+asyncpg://kustos:••••@postgres:5432/kustos", source: "env", restart: true, locked: true },
        { key: "pool_size", value: "20", source: "db", restart: true },
        { key: "max_overflow", value: "10", source: "db", restart: true },
        { key: "pool_timeout", value: "30", source: "default", restart: true },
        { key: "pg_ssl_mode", value: "prefer", source: "default", restart: true }
      ]
    },
    {
      name: "storage", writable: true, hot: true,
      keys: [
        { key: "repo_root", value: "/data/repositories", source: "env", restart: true, locked: true },
        { key: "upload_root", value: "/data/uploads", source: "env", restart: true, locked: true },
        { key: "max_upload_size", value: "104857600", source: "db", hot: true }
      ]
    },
    {
      name: "search", writable: true, hot: true,
      keys: [
        { key: "enabled", value: "true", source: "db", hot: true },
        { key: "embedding_model", value: "text-embedding-3-small", source: "db", hot: true },
        { key: "chunk_size", value: "900", source: "default", hot: true },
        { key: "top_k", value: "12", source: "db", hot: true }
      ]
    },
    {
      name: "agent", writable: false, hot: true, dedicated: "PUT /api/app/agent/config",
      keys: [
        { key: "enabled", value: "true", source: "db", hot: true },
        { key: "model", value: "gpt-4.1-mini", source: "db", hot: true },
        { key: "max_steps", value: "24", source: "db", hot: true },
        { key: "token_budget", value: "120000", source: "db", hot: true },
        { key: "worker_max_jobs", value: "3", source: "env", restart: true }
      ]
    },
    {
      name: "realtime", writable: false, hot: true,
      keys: [
        { key: "ws_heartbeat_timeout_seconds", value: "120", source: "default", hot: true },
        { key: "ws_max_message_bytes", value: "262144", source: "default", hot: true },
        { key: "presence_ttl", value: "90", source: "db", hot: true }
      ]
    },
    {
      name: "security", writable: false, hot: false,
      keys: [
        { key: "secret_key", value: "••••••••••••", source: "env", restart: true, locked: true },
        { key: "access_token_minutes", value: "30", source: "db", hot: true },
        { key: "refresh_token_days", value: "7", source: "db", hot: true }
      ]
    },
    {
      name: "metrics", writable: false, hot: false,
      keys: [
        { key: "history_minutes", value: "1440", source: "db", hot: true },
        { key: "prometheus_enabled", value: "true", source: "env", restart: true }
      ]
    },
    {
      name: "collab", writable: false, hot: true,
      keys: [
        { key: "internal_secret", value: "••••••••••••", source: "env", restart: true, locked: true },
        { key: "gateway_url", value: "http://collab:4444", source: "env", restart: true }
      ]
    }
  ];

  const AGENT = {
    enabled: true,
    provider: "openai",
    model: "gpt-4.1-mini",
    key_state: { configured: true, source: "db" },
    limits: { job_budget: 120000, daily_budget: 2000000, concurrency: 3, max_steps: 24 },
    providers: ["openai", "anthropic", "azure-openai", "openai-compatible"],
    usage: {
      days: 7,
      daily: [
        { date: "2026-10-22", jobs: 4, succeeded: 4, failed: 0, tokens: 142000, avg_duration_s: 61 },
        { date: "2026-10-23", jobs: 6, succeeded: 5, failed: 1, tokens: 208000, avg_duration_s: 74 },
        { date: "2026-10-24", jobs: 3, succeeded: 3, failed: 0, tokens: 96000, avg_duration_s: 52 },
        { date: "2026-10-25", jobs: 8, succeeded: 7, failed: 1, tokens: 301000, avg_duration_s: 83 },
        { date: "2026-10-26", jobs: 5, succeeded: 5, failed: 0, tokens: 184000, avg_duration_s: 69 },
        { date: "2026-10-27", jobs: 9, succeeded: 7, failed: 2, tokens: 356000, avg_duration_s: 91 },
        { date: "2026-10-28", jobs: 5, succeeded: 4, failed: 1, tokens: 193000, avg_duration_s: 66 }
      ],
      totals: { jobs: 40, succeeded: 35, failed: 5, tokens: 1480000, avg_duration_s: 73 },
      tools: [
        { name: "search_code", calls: 412 },
        { name: "read_file", calls: 366 },
        { name: "get_diff", calls: 188 },
        { name: "find_usages", calls: 97 },
        { name: "create_issue", calls: 12 }
      ]
    }
  };

  const SEARCH = {
    semantic_enabled: true,
    current_generation: 3,
    key_state: { configured: true, source: "env" },
    totals: { repos: 3, chunks: 28740, embeddings: 28740, refs: 64, stale: 1 },
    repos: [
      { id: "r-1", name: "lin/atlas", path: "lin/atlas", head_commit: "8f3c2a1", indexed_commit: "8f3c2a1", in_sync: true, chunks: 12408, refs: 38, embeddings: 12408, last_indexed_at: "8m ago" },
      { id: "r-2", name: "lin/harbor", path: "lin/harbor", head_commit: "c14b7e2", indexed_commit: "1a9f0d4", in_sync: false, chunks: 9210, refs: 18, embeddings: 9210, last_indexed_at: "3h ago" },
      { id: "r-3", name: "lin/lantern", path: "lin/lantern", head_commit: "77ae301", indexed_commit: "77ae301", in_sync: true, chunks: 7122, refs: 8, embeddings: 7122, last_indexed_at: "26m ago" }
    ]
  };

  const AUDIT = [
    { id: "a-01", at: "15:10:41", actor: "lin", source: "http", method: "GET", path: "/api/app/metrics/timeseries?range=1h", status: 200, ip: "10.20.4.18", sensitive: false, request_id: "b41f9c2a", ua: "Chrome 141 / macOS", note: "Admin opened Overview" },
    { id: "a-02", at: "15:08:12", actor: "ada", source: "http", method: "PUT", path: "/api/v1/users/u-10", status: 200, ip: "10.20.4.22", sensitive: true, request_id: "7d1e0b88", ua: "Firefox 142 / Linux", action: "user.disable", entity: "user:u-10", note: "Set is_active=false on Kenji Watanabe" },
    { id: "a-03", at: "14:58:03", actor: "kustos", source: "activity", method: "POST", path: "agent.approve", status: 200, ip: "—", sensitive: false, request_id: "—", entity: "agent_run:A-1042", action: "agent.approve", note: "Approved create_issue after human decision" },
    { id: "a-04", at: "14:51:37", actor: "lin", source: "http", method: "PUT", path: "/api/app/agent/config", status: 409, ip: "10.20.4.18", sensitive: true, request_id: "0c9a71ee", ua: "Chrome 141 / macOS", note: "Stale row version — agent_config_version_conflict" },
    { id: "a-05", at: "14:51:20", actor: "lin", source: "http", method: "GET", path: "/api/app/components", status: 200, ip: "10.20.4.18", sensitive: false, request_id: "5b7710fa", ua: "Chrome 141 / macOS", note: "Docker socket reachable" },
    { id: "a-06", at: "14:47:55", actor: "mara", source: "http", method: "GET", path: "/api/v1/repositories/r-1/pulls", status: 200, ip: "10.20.9.7", sensitive: false, request_id: "e2c4019b", ua: "Safari 18 / macOS" },
    { id: "a-07", at: "14:40:09", actor: "ada", source: "http", method: "POST", path: "/api/app/monitoring/enabled", status: 409, ip: "10.20.4.22", sensitive: true, request_id: "9af0c311", ua: "Firefox 142 / Linux", note: "monitoring_not_deployed — stack was never created" },
    { id: "a-08", at: "14:32:44", actor: "lin", source: "http", method: "GET", path: "/api/app/logs/content?log_name=error&lines=200", status: 200, ip: "10.20.4.18", sensitive: false, request_id: "31c8de07", ua: "Chrome 141 / macOS" },
    { id: "a-09", at: "14:20:18", actor: "noor", source: "activity", method: "POST", path: "pull.merge", status: 200, ip: "—", sensitive: false, request_id: "—", entity: "pull_request:136", action: "pull.merge", note: "Squash merged after 1 approval, 3 checks" },
    { id: "a-10", at: "14:11:02", actor: "ilya", source: "http", method: "GET", path: "/api/app/status", status: 403, ip: "10.20.7.51", sensitive: false, request_id: "aa55b210", ua: "Chrome 141 / Windows", note: "Member hit an admin endpoint — app_admin_or_debug_required" },
    { id: "a-11", at: "13:58:37", actor: "ada", source: "http", method: "POST", path: "/api/app/config/validate", status: 200, ip: "10.20.4.22", sensitive: false, request_id: "c7710a4e", ua: "Firefox 142 / Linux" },
    { id: "a-12", at: "13:44:12", actor: "system", source: "activity", method: "POST", path: "search.reindex", status: 200, ip: "—", sensitive: false, request_id: "—", entity: "repository:r-2", action: "search.reindex", note: "Generation 3 · 9,210 chunks rebuilt" },
    { id: "a-13", at: "13:30:55", actor: "lin", source: "http", method: "POST", path: "/api/app/restart", status: 200, ip: "10.20.4.18", sensitive: true, request_id: "4e0b8811", ua: "Chrome 141 / macOS", note: "Agent worker restarted after deploy" },
    { id: "a-14", at: "13:22:09", actor: "theo", source: "activity", method: "POST", path: "repo.push", status: 200, ip: "—", sensitive: false, request_id: "—", entity: "repository:r-1", action: "repo.push", note: "2 commits to mara/lfs-token-scope" },
    { id: "a-15", at: "13:05:44", actor: "lin", source: "http", method: "DELETE", path: "/api/app/logs/cleanup?keep_days=14", status: 200, ip: "10.20.4.18", sensitive: true, request_id: "f20c7d19", ua: "Chrome 141 / macOS", note: "Removed 31 files older than 14 days" },
    { id: "a-16", at: "12:48:31", actor: "priya", source: "http", method: "GET", path: "/api/v1/users/me/notifications", status: 200, ip: "10.20.6.9", sensitive: false, request_id: "8b3a55d2", ua: "Chrome 140 / Linux" },
    { id: "a-17", at: "12:31:07", actor: "ada", source: "http", method: "PUT", path: "/api/v1/users/u-03", status: 200, ip: "10.20.4.22", sensitive: true, request_id: "1d904cbe", ua: "Firefox 142 / Linux", action: "user.update", entity: "user:u-03", note: "Granted repository admin on harbor" },
    { id: "a-18", at: "12:14:59", actor: "lin", source: "http", method: "POST", path: "/api/app/monitoring/grafana/sso", status: 502, ip: "10.20.4.18", sensitive: false, request_id: "6f2ba03c", ua: "Chrome 141 / macOS", note: "grafana_login_failed — container stopped" }
  ];

  const LOG_FILES = {
    app: [
      { t: "15:11:58", level: "INFO", msg: "GET /api/app/metrics/timeseries?range=1h 200 42ms user=lin", req: "b41f9c2a" },
      { t: "15:11:41", level: "INFO", msg: "arq worker 47 claimed job a3f1 · run=A-1043 step=4", req: "—" },
      { t: "15:10:22", level: "INFO", msg: "ws connect user=lin rooms=3 protocol=kustos-bearer", req: "0a11c9" },
      { t: "15:09:57", level: "INFO", msg: "search index lin/atlas head=8f3c2a1 chunks=12408 (+0)", req: "—" },
      { t: "15:08:12", level: "WARN", msg: "admin action user=ada path=/api/v1/users/u-10 sensitive=true", req: "7d1e0b88" },
      { t: "15:07:03", level: "INFO", msg: "GET /api/v1/repositories/r-1/pulls 200 61ms user=mara", req: "e2c4019b" },
      { t: "15:05:48", level: "DEBUG", msg: "redis hit kustos:repo:r-1:head ttl=118", req: "—" },
      { t: "15:04:19", level: "INFO", msg: "git post-receive repo=lin/harbor refs=1 size=18.4kb", req: "—" },
      { t: "15:02:55", level: "INFO", msg: "agent run A-1043 tool=read_file path=app/services/lfs.py 112ms", req: "—" },
      { t: "15:01:30", level: "WARN", msg: "concurrency slot saturated 12/12, queue=3", req: "—" },
      { t: "14:59:44", level: "INFO", msg: "GET /api/app/components 200 18ms user=lin", req: "5b7710fa" },
      { t: "14:58:03", level: "INFO", msg: "agent approval run=A-1042 tool=create_issue decision=approved", req: "—" },
      { t: "14:56:12", level: "DEBUG", msg: "presence heartbeat users=9 rooms=4 shard=0", req: "—" },
      { t: "14:54:37", level: "INFO", msg: "POST /api/v1/repositories/r-1/issues 201 88ms user=noor", req: "3c9ab112" },
      { t: "14:52:08", level: "INFO", msg: "collab save docKey=r-1:main:app/services/lfs.py bytes=8124 user=mara", req: "—" },
      { t: "14:51:37", level: "WARN", msg: "agent config conflict version=41 expected=42 user=lin", req: "0c9a71ee" },
      { t: "14:48:20", level: "INFO", msg: "GET /api/v1/search?q=transfer_token 200 34ms user=ilya", req: "77d1c0aa" },
      { t: "14:45:02", level: "INFO", msg: "branch protection check repo=r-1 base=main result=allow", req: "—" },
      { t: "14:41:55", level: "DEBUG", msg: "db pool size=20 in_use=6 overflow=0 waits=0", req: "—" },
      { t: "14:38:11", level: "INFO", msg: "webhook delivery hook=wh-3 event=pull_request.synced status=200", req: "—" }
    ],
    error: [
      { t: "15:01:30", level: "ERROR", msg: "ConcurrencyMiddleware rejected request: admission timeout after 12.0s (slots=12)", req: "—" },
      { t: "14:51:37", level: "ERROR", msg: "AgentConfigVersionConflict version=41 expected=42 user=lin", req: "0c9a71ee" },
      { t: "14:40:09", level: "ERROR", msg: "MonitoringNotDeployed: compose project kustos has no prometheus/grafana container", req: "9af0c311" },
      { t: "14:12:44", level: "ERROR", msg: "grafana_login_failed: connection refused http://grafana:3000/api/login", req: "6f2ba03c" },
      { t: "13:58:52", level: "WARN", msg: "git post-receive hook slow repo=lin/atlas 2.8s (threshold 2.0s)", req: "—" },
      { t: "13:22:09", level: "ERROR", msg: "search embedding batch failed provider=openai status=429 retry=2", req: "—" },
      { t: "12:47:31", level: "WARN", msg: "redis reconnect attempt 1 namespace=kustos cooldown=5s", req: "—" },
      { t: "12:11:06", level: "ERROR", msg: "SSE stream aborted client=10.20.5.44 path=/ws reason=heartbeat_timeout", req: "—" }
    ],
    audit: [
      { t: "15:08:12", level: "AUDIT", msg: "user=ada ip=10.20.4.22 PUT /api/v1/users/u-10 status=200 sensitive=true", req: "7d1e0b88" },
      { t: "14:51:37", level: "AUDIT", msg: "user=lin ip=10.20.4.18 PUT /api/app/agent/config status=409 sensitive=true", req: "0c9a71ee" },
      { t: "14:40:09", level: "AUDIT", msg: "user=ada ip=10.20.4.22 POST /api/app/monitoring/enabled status=409", req: "9af0c311" },
      { t: "14:11:02", level: "AUDIT", msg: "user=ilya ip=10.20.7.51 GET /api/app/status status=403 denied=not_admin", req: "aa55b210" },
      { t: "13:44:12", level: "AUDIT", msg: "system POST search.reindex entity=repository:r-2 generation=3", req: "—" },
      { t: "13:30:55", level: "AUDIT", msg: "user=lin ip=10.20.4.18 POST /api/app/restart status=200 sensitive=true", req: "4e0b8811" },
      { t: "13:05:44", level: "AUDIT", msg: "user=lin ip=10.20.4.18 DELETE /api/app/logs/cleanup keep_days=14 deleted=31", req: "f20c7d19" }
    ]
  };

  const API_MAP = {
    overview: [
      { m: "GET", p: "/api/app/status", note: "uptime, process, requests, git ops, schema_state", guard: "admin" },
      { m: "GET", p: "/api/app/metrics/timeseries?range=5m…24h", note: "rpm / err_rate / p95 / mem / cpu，Redis 或进程内", guard: "admin" },
      { m: "GET", p: "/api/app/components", note: "summarise 与组件条目的同一数据源", guard: "admin" },
      { m: "GET", p: "/api/app/audit?limit=5&days=1", note: "Overview 的近期特权动作", guard: "admin" }
    ],
    runtime: [
      { m: "GET", p: "/api/app/components", note: "只读 Docker socket 代理；不可用时 available=false", guard: "admin" },
      { m: "GET", p: "/api/app/monitoring", note: "Grafana / Prometheus 的 running·configured·ready", guard: "admin" },
      { m: "POST", p: "/api/app/monitoring/enabled", note: "启停可选监控栈；从未部署 → 409", guard: "admin" },
      { m: "GET", p: "/api/app/monitoring/grafana/sso", note: "下发 grafana_session Cookie 后跳 /grafana", guard: "admin" },
      { m: "GET", p: "/api/app/redis/status", note: "探活、worker 注册表、PUBSUB NUMPAT、降级计数", guard: "admin" },
      { m: "GET", p: "/api/app/redis/config", note: "连接 URL 脱敏，editable=false", guard: "admin" },
      { m: "POST", p: "/api/app/restart", note: "危险操作：admin 或 本机+debug", guard: "admin" },
      { m: "POST", p: "/api/app/shutdown", note: "危险操作：admin 或 本机+debug", guard: "admin" }
    ],
    access: [
      { m: "GET", p: "/api/v1/users", note: "用户列表（需登录）", guard: "session" },
      { m: "PUT", p: "/api/v1/users/{user_id}", note: "is_admin / is_active 仅管理员可设", guard: "admin" },
      { m: "POST", p: "/api/v1/users/{user_id}/password", note: "管理员重置密码", guard: "admin" },
      { m: "DELETE", p: "/api/v1/users/{user_id}", note: "硬删除，慎用", guard: "admin" },
      { m: "—", p: "KUSTOS_ADMIN_ALLOWED_SOURCES", note: "网关 admin_acl.lua；不是 API，改 .env 后 reload 网关", guard: "gateway" }
    ],
    configuration: [
      { m: "GET", p: "/api/app/config", note: "meta.sources 标注 env / db / default", guard: "admin或debug" },
      { m: "POST", p: "/api/app/config", note: "按节写入 app_config；受保护节整节拒绝", guard: "admin" },
      { m: "POST", p: "/api/app/config/validate", note: "先校验再落库", guard: "admin" },
      { m: "POST", p: "/api/app/config/reset", note: "回退到默认值", guard: "admin" },
      { m: "PUT", p: "/api/app/agent/config", note: "带 version 的乐观锁；冲突 409", guard: "admin" },
      { m: "PUT", p: "/api/app/search/config", note: "同上，密钥密文落库", guard: "admin" }
    ],
    capabilities: [
      { m: "GET", p: "/api/app/agent/config", note: "meta.editable_keys / hot_keys / version", guard: "admin" },
      { m: "GET", p: "/api/app/agent/key-status", note: "configured + source，不回显密钥", guard: "admin" },
      { m: "POST", p: "/api/app/agent/test-connection", note: "供应商连通性测试", guard: "admin" },
      { m: "GET", p: "/api/app/agent/usage?days=7", note: "daily jobs/tokens/tools 聚合", guard: "admin" },
      { m: "GET", p: "/api/app/search/index-overview", note: "逐仓 in_sync / chunks / embeddings", guard: "admin" },
      { m: "PUT", p: "/api/app/search/config", note: "embedding key 写入与清除", guard: "admin" }
    ],
    audit: [
      { m: "GET", p: "/api/app/audit", note: "http 审计 + activities 合并；days ≤ 90", guard: "admin" },
      { m: "GET", p: "/api/app/audit?source=http|activity", note: "source 决定可用过滤项", guard: "admin" },
      { m: "GET", p: "/api/app/audit?sensitive=true", note: "只看敏感操作", guard: "admin" }
    ],
    logs: [
      { m: "GET", p: "/api/app/logs", note: "日志目录、可用日期", guard: "admin或debug" },
      { m: "GET", p: "/api/app/logs/content", note: "date / log_name / lines ≤ 5000 / level", guard: "admin或debug" },
      { m: "POST", p: "/api/app/logs/cleanup", note: "保留天数 1–365，危险操作", guard: "admin" },
      { m: "WS", p: "/ws/logs", note: "订阅实时日志；非管理员 1008 关闭", guard: "admin" }
    ]
  };

  return {
    INSTANCE,
    COMPONENT_GROUPS,
    COMPONENTS,
    COMPONENT_SUMMARY,
    MONITORING,
    REDIS,
    RANGES,
    series,
    ACL,
    USERS,
    CONFIG,
    AGENT,
    SEARCH,
    AUDIT,
    LOG_FILES,
    API_MAP
  };
})();
