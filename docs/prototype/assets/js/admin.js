/* Admin console: seven sections over one canvas, plus a floating inspector.
   Every value is shaped after the controller payloads in admin-data.js so the
   prototype can be read against /api/app/* without a translation layer. */
(function () {
  "use strict";

  const U = window.KustosUtil;
  const K = window.Kustos;
  const D = window.KustosAdminData;
  const esc = U.escapeHtml;
  const ico = K.ico;

  const IS_ADMIN = document.body.dataset.viewer !== "member";
  const stage = document.getElementById("admin-stage");
  const core = document.getElementById("admin-core");
  const canvas = document.getElementById("admin-canvas");
  const rail = document.querySelector(".admin-rail");

  const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "runtime", label: "Runtime" },
    { id: "access", label: "Access" },
    { id: "configuration", label: "Configuration" },
    { id: "capabilities", label: "Capabilities" },
    { id: "audit", label: "Audit log" },
    { id: "logs", label: "Logs" }
  ];

  const state = {
    section: "overview",
    range: "1h",
    selected: null,
    userFilter: "all",
    userQuery: "",
    audit: { source: "all", days: 7, q: "", method: "", sensitive: false },
    configSection: "server",
    dirty: new Map(),
    log: { file: "app", level: "all", date: "2026-10-28", lines: 100, tail: true },
    monitoringRunning: D.MONITORING.grafana.running
  };

  let tailTimer = 0;
  let pendingConfirm = null;

  /* ---------------------------------------------------------------- utils */

  const num = (value) => Number(value).toLocaleString("en-US");
  const pad = (value) => String(value).padStart(2, "0");
  const timeOf = (epoch) => {
    const d = new Date(epoch);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  function lampFor(component) {
    if (!component.running) {
      return component.exit_code === 0 ? "is-faint" : "is-bad";
    }
    if (component.health === "unhealthy") return "is-bad";
    if (component.health === "starting") return "is-warn";
    return "is-good";
  }

  function stateBadge(component) {
    if (component.running) {
      return `<span class="badge ${component.health === "unhealthy" ? "is-bad" : component.health === "starting" ? "is-warn" : "is-good"}">${esc(component.health || "running")}</span>`;
    }
    if (component.exit_code === 0) return '<span class="badge">exited 0</span>';
    return `<span class="badge is-bad">exited ${component.exit_code === null ? "?" : component.exit_code}</span>`;
  }

  function uptime(seconds) {
    if (seconds === null || seconds === undefined) return "—";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function sectionHead(eyebrow, title, lede, actions) {
    return `<header class="sec-head">
      <div class="sec-head-copy">
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h2>${esc(title)}</h2>
        <p class="sec-lede">${lede}</p>
      </div>
      ${actions ? `<div class="sec-head-actions">${actions}</div>` : ""}
    </header>`;
  }

  function cardHead(title, meta, actions) {
    return `<div class="card-head">
      <div class="card-title-row"><h3>${esc(title)}</h3>${meta ? `<span class="card-meta">${meta}</span>` : ""}</div>
      ${actions || ""}
    </div>`;
  }

  function sourceBadge(source) {
    const label = source === "env" ? "env" : source === "db" ? "db" : "default";
    const tone = source === "env" ? "is-env" : source === "db" ? "is-db" : "is-default";
    return `<span class="cfg-source ${tone}">${label}</span>`;
  }

  /* ------------------------------------------------------------ overview */

  function kpi(label, value, unit, meta, tone) {
    return `<div class="kpi${tone ? ` ${tone}` : ""}">
      <span class="kpi-label">${esc(label)}</span>
      <span class="kpi-value">${value}${unit ? `<span class="kpi-unit">${unit}</span>` : ""}</span>
      <span class="kpi-meta">${meta}</span>
    </div>`;
  }

  function overviewMarkup() {
    const s = D.series(state.range);
    const last = s.points[s.points.length - 1];
    const peak = Math.max(...s.points.map((p) => p.rpm));
    const avg = Math.round(s.points.reduce((sum, p) => sum + p.rpm, 0) / s.points.length);
    const errors = s.points.reduce((sum, p) => sum + p.s5xx, 0);
    const schema = D.INSTANCE.schema_state;
    const inSync = schema.applied === schema.head;
    const running = D.COMPONENTS.filter((c) => c.running).length;

    return `${sectionHead(
      "Observe",
      "Overview",
      "Instance health, request pressure and the privileged actions taken today. Read-only until you open Runtime or Configuration.",
      `<div class="segmented" role="group" aria-label="Time range">
        ${Object.keys(D.RANGES).map((key) => `<button type="button" data-range="${key}" class="${key === state.range ? "is-active" : ""}">${key}</button>`).join("")}
      </div>`
    )}

    <div class="kpi-grid">
      ${kpi("Requests / min", num(last.rpm), "", `peak ${peak} · avg ${avg}`)}
      ${kpi("Error rate", last.err_rate.toFixed(2), "%", `${errors} 5xx in ${esc(s.label)}`, last.err_rate > 0.8 ? "is-warn" : "")}
      ${kpi("P95 latency", last.p95_ms, "ms", `avg ${last.avg_ms} ms`)}
      ${kpi("Memory", last.mem_mb, "MB", `${D.INSTANCE.process.threads} threads · ${D.INSTANCE.process.connections} conns`)}
      ${kpi("Uptime", `${Math.floor(D.INSTANCE.uptime_seconds / 86400)}d ${Math.floor((D.INSTANCE.uptime_seconds % 86400) / 3600)}h`, "", `since 22 Oct · <span class="mono">${esc(D.INSTANCE.version)}</span>`)}
    </div>

    <section class="card chart-card">
      ${cardHead(
        "Request rate & 5xx",
        `<span class="mono">${esc(s.range)}</span> · step ${s.step}s · source <span class="badge is-mono">${esc(s.source)}</span>`,
        ""
      )}
      <div class="chart">
        <div class="chart-readout" id="chart-readout"></div>
        ${chartMarkup(s)}
      </div>
      <div class="chart-foot">
        <span><i class="chart-dot is-amber"></i>requests / min</span>
        <span><i class="chart-dot is-rose"></i>5xx share (right axis, 0–2%)</span>
        <span class="spacer"></span>
        <span class="fine">Retention <span class="mono">1440 min</span> · Redis buckets, process-inline fallback</span>
      </div>
    </section>

    <div class="split-2">
      <section class="card">
        ${cardHead("Process & schema", "GET /api/app/status")}
        <dl class="kv compact">
          <div class="kv-row"><dt class="kv-key">Version</dt><dd class="kv-val is-mono">${esc(D.INSTANCE.version)}</dd></div>
          <div class="kv-row"><dt class="kv-key">Debug mode</dt><dd class="kv-val"><span class="badge">${D.INSTANCE.debug_mode ? "on" : "off"}</span></dd></div>
          <div class="kv-row"><dt class="kv-key">PID / workers</dt><dd class="kv-val is-mono">${D.INSTANCE.process.pid} · 4</dd></div>
          <div class="kv-row"><dt class="kv-key">Schema</dt><dd class="kv-val"><span class="mono">${esc(schema.applied)}</span>${inSync ? ' <span class="badge is-good">head</span>' : ' <span class="badge is-bad">behind head</span>'}</dd></div>
          <div class="kv-row"><dt class="kv-key">Git operations</dt><dd class="kv-val">${D.INSTANCE.git_operations.active_clones} clones · ${D.INSTANCE.git_operations.active_pushes} pushes</dd></div>
          <div class="kv-row"><dt class="kv-key">Request totals</dt><dd class="kv-val is-mono">${num(D.INSTANCE.requests.total)}</dd></div>
        </dl>
      </section>

      <section class="card">
        ${cardHead(
          "Components",
          `${running}/${D.COMPONENT_SUMMARY.total} running`,
          `<button class="text-link" type="button" data-goto="runtime">Open Runtime ↗</button>`
        )}
        <div class="comp-summary">
          ${D.COMPONENT_GROUPS.map((group) => {
            const items = D.COMPONENTS.filter((c) => c.group === group.key);
            const down = items.filter((c) => !c.running && c.exit_code !== 0);
            const optional = group.optional;
            return `<div class="comp-summary-row">
              <span class="comp-summary-key">${esc(group.label)}</span>
              <span class="comp-dots">${items.map((c) => `<span class="lamp ${lampFor(c)}" title="${esc(c.service)}" aria-label="${esc(c.service)}"></span>`).join("")}</span>
              <span class="comp-summary-state ${down.length ? "is-warn" : optional && items.every((c) => !c.running) ? "is-faint" : ""}">${
                optional && items.every((c) => !c.running) ? "optional · stopped" : down.length ? `${down.length} stopped` : `${items.length} up`
              }</span>
            </div>`;
          }).join("")}
        </div>
        <p class="card-note"><span class="lamp is-warn" aria-hidden="true"></span>Observability stack is optional and currently stopped — metrics still record in-process.</p>
      </section>
    </div>

    <section class="card">
      ${cardHead(
        "Privileged actions",
        "last 6 · merged audit sources",
        `<button class="text-link" type="button" data-goto="audit">Audit log ↗</button>`
      )}
      <table class="tbl tbl-compact">
        <thead class="sr-only"><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>
        <tbody>
          ${D.AUDIT.slice(0, 6).map((row) => `<tr class="is-clickable" data-audit="${row.id}">
            <td class="mono">${esc(row.at)}</td>
            <td><span class="actor">${esc(row.actor)}</span></td>
            <td><span class="method">${esc(row.method)}</span> <span class="mono path">${esc(row.path)}</span></td>
            <td>${row.sensitive ? '<span class="badge is-warn">sensitive</span>' : '<span class="fine">—</span>'}</td>
            <td><span class="badge ${row.status < 400 ? "is-good" : row.status === 403 || row.status === 409 ? "is-warn" : "is-bad"}">${row.status}</span></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>`;
  }

  /* --------------------------------------------------------------- chart */

  function chartMarkup(series) {
    const points = series.points;
    const W = 1000;
    const H = 250;
    const L = 52;
    const R = 56;
    const T = 18;
    const B = 32;
    const maxRpm = Math.ceil(Math.max(...points.map((p) => p.rpm)) / 100) * 100;
    const maxErr = 2;
    const innerW = W - L - R;
    const innerH = H - T - B;
    const x = (i) => L + (innerW * i) / (points.length - 1);
    const y = (v) => T + innerH * (1 - v / maxRpm);
    const y2 = (v) => T + innerH * (1 - v / maxErr);

    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.rpm).toFixed(1)}`).join("");
    const area = `${line}L${x(points.length - 1).toFixed(1)},${H - B}L${L},${H - B}Z`;
    const errLine = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y2(p.err_rate).toFixed(1)}`).join("");

    const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
      const value = Math.round(maxRpm * ratio);
      const yy = y(value);
      return `<line class="chart-grid" x1="${L}" y1="${yy.toFixed(1)}" x2="${W - R}" y2="${yy.toFixed(1)}"></line>
        <text class="chart-axis" x="${L - 10}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${value}</text>
        <text class="chart-axis is-right" x="${W - R + 10}" y="${(yy + 4).toFixed(1)}">${(maxErr * ratio).toFixed(1)}%</text>`;
    }).join("");

    const ticks = [0, 6, 12, 18, 24, points.length - 1].map((index) => {
      return `<text class="chart-axis" x="${x(index).toFixed(1)}" y="${H - 8}" text-anchor="middle">${timeOf(points[index].t)}</text>`;
    }).join("");

    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Request rate and error share over ${esc(series.label)}">
      <defs>
        <linearGradient id="adminChartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(242,174,91,0.34)"></stop>
          <stop offset="100%" stop-color="rgba(242,174,91,0.02)"></stop>
        </linearGradient>
      </defs>
      ${grid}
      <path class="chart-area" d="${area}"></path>
      <path class="chart-line" d="${line}"></path>
      <path class="chart-line-err" d="${errLine}"></path>
      ${ticks}
      <line class="chart-cross" x1="0" y1="${T}" x2="0" y2="${H - B}" opacity="0"></line>
      <circle class="chart-dot-mark" cx="0" cy="0" r="3.5" opacity="0"></circle>
    </svg>`;
  }

  function bindChart() {
    const svg = canvas.querySelector(".chart-svg");
    if (!svg) return;
    const series = D.series(state.range);
    const points = series.points;
    const readout = document.getElementById("chart-readout");
    const cross = svg.querySelector(".chart-cross");
    const dot = svg.querySelector(".chart-dot-mark");
    const W = 1000, L = 52, R = 56, T = 18, B = 32;
    const maxRpm = Math.ceil(Math.max(...points.map((p) => p.rpm)) / 100) * 100;
    const innerH = 250 - T - B;

    const paint = (index) => {
      const p = points[index];
      readout.innerHTML = `
        <span class="readout-time mono">${timeOf(p.t)}</span>
        <span><i class="chart-dot is-amber"></i><b>${p.rpm}</b> req/min</span>
        <span><i class="chart-dot is-rose"></i><b>${p.err_rate.toFixed(2)}%</b> 5xx</span>
        <span><b>${p.p95_ms} ms</b> p95</span>
        <span class="muted-2"><b>${p.mem_mb} MB</b> rss</span>`;
      const xx = L + ((1000 - L - R) * index) / (points.length - 1);
      const yy = T + innerH * (1 - p.rpm / maxRpm);
      cross.setAttribute("x1", xx);
      cross.setAttribute("x2", xx);
      cross.setAttribute("opacity", "1");
      dot.setAttribute("cx", xx);
      dot.setAttribute("cy", yy);
      dot.setAttribute("opacity", "1");
    };

    paint(points.length - 1);

    svg.addEventListener("mousemove", (event) => {
      const box = svg.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      paint(Math.round(ratio * (points.length - 1)));
    });
    svg.addEventListener("mouseleave", () => {
      cross.setAttribute("opacity", "0");
      dot.setAttribute("opacity", "0");
    });
  }

  /* ------------------------------------------------------------- runtime */

  function syncMonitoring() {
    D.COMPONENTS.filter((c) => c.group === "observe").forEach((c) => {
      const on = state.monitoringRunning;
      c.running = on;
      c.state = on ? "running" : "exited";
      c.health = on ? "healthy" : null;
      c.uptime_seconds = on ? 48 : null;
      c.exit_code = on ? null : 143;
      c.status_text = on ? "Up 48 seconds (healthy)" : "Exited (143) 4 days ago";
    });
  }

  function runtimeMarkup() {
    syncMonitoring();
    const summary = D.COMPONENT_SUMMARY;
    const monitoring = state.monitoringRunning;
    const core = D.COMPONENTS.filter((c) => c.group !== "observe" && c.group !== "job");
    const coreRunning = core.filter((c) => c.running).length;
    const optional = D.COMPONENTS.filter((c) => c.group === "observe");
    const optionalRunning = monitoring ? optional.length : 0;
    return `${sectionHead(
      "Observe",
      "Runtime",
      "Compose components, the optional monitoring stack and Redis. Component health comes from a read-only Docker socket proxy; when it is unavailable the endpoint returns <code>available=false</code> instead of failing.",
      `<button class="btn btn-ghost btn-sm" type="button" data-toast="Component list refreshed from /api/app/components.">${ico("refresh")}Refresh</button>
       <button class="btn btn-quiet btn-sm" type="button" data-goto="logs">${ico("terminal")}Open logs</button>`
    )}

    <div class="runway">
      <span class="runway-key">Core</span>
      <strong>${coreRunning}/${core.length}</strong>
      <span class="runway-sep" aria-hidden="true"></span>
      <span class="runway-key">Optional</span>
      <strong>${optionalRunning}/${optional.length}</strong>
      <span class="runway-sep" aria-hidden="true"></span>
      <span class="runway-key">Healthy</span>
      <strong>${monitoring ? summary.healthy + 2 : summary.healthy}</strong>
      <span class="spacer"></span>
      <span class="fine"><span class="mono">docker</span> · project <span class="mono">kustos</span> · generated ${esc(D.MONITORING.generated_at.slice(11, 19))}Z</span>
    </div>

    <section class="card card-flush">
      ${cardHead("Components", "13 containers · grouped by role", '<span class="badge is-mono">docker</span>')}
      <div class="tbl-scroll">
      <table class="tbl comp-table">
        <thead>
          <tr><th class="col-lamp"></th><th>Service</th><th>Image</th><th>State</th><th>Uptime</th><th class="col-num">Restarts</th><th class="col-chev"></th></tr>
        </thead>
        <tbody>
          ${D.COMPONENT_GROUPS.map((group) => {
            const items = D.COMPONENTS.filter((c) => c.group === group.key);
            return `<tr class="tbl-group"><td colspan="7"><span class="tbl-group-label">${esc(group.label)}</span><span class="tbl-group-note">${group.optional ? "optional stack" : group.key === "job" ? "runs once per deploy" : ""}</span></td></tr>` +
              items.map((c) => `<tr class="is-clickable${c.running ? "" : " is-quiet"}" data-comp="${esc(c.service)}">
                <td class="col-lamp"><span class="lamp ${lampFor(c)}" aria-hidden="true"></span></td>
                <td>
                  <span class="comp-name mono">${esc(c.service)}</span>
                  <span class="comp-label">${esc(c.label)}</span>
                </td>
                <td class="mono comp-image">${esc(c.image)}</td>
                <td>${stateBadge(c)}</td>
                <td class="mono">${uptime(c.uptime_seconds)}</td>
                <td class="col-num mono">${c.restart_count}</td>
                <td class="col-chev">${ico("chevron-right", "icon-xs")}</td>
              </tr>`).join("");
          }).join("")}
        </tbody>
      </table>
      </div>
      <p class="card-foot-note">Exited <span class="mono">init</span> is the migration + admin bootstrap job — exit code 0 is the expected terminal state.</p>
    </section>

    <div class="split-2">
      <section class="card">
        ${cardHead("Monitoring stack", monitoring ? "running" : "stopped", '<span class="badge is-outline">optional</span>')}
        <div class="mon-service">
          <div class="mon-service-copy">
            <span class="lamp ${monitoring ? "is-good" : "is-faint"}" aria-hidden="true"></span>
            <div><strong>Grafana</strong><span class="mono">grafana/grafana:11.3.0</span></div>
          </div>
          <span class="badge ${monitoring ? "is-good" : ""}">${monitoring ? "ready · /grafana" : "stopped"}</span>
        </div>
        <div class="mon-service">
          <div class="mon-service-copy">
            <span class="lamp ${monitoring ? "is-good" : "is-faint"}" aria-hidden="true"></span>
            <div><strong>Prometheus</strong><span class="mono">prom/prometheus:v3.0.1</span></div>
          </div>
          <span class="badge ${monitoring ? "is-good" : ""}">${monitoring ? "ready · scraping" : "stopped"}</span>
        </div>
        <div class="mon-actions">
          <button class="btn ${monitoring ? "btn-quiet" : "btn-ghost"} btn-sm" type="button" data-mon-toggle>
            ${ico(monitoring ? "x" : "play")}${monitoring ? "Stop stack" : "Start stack"}
          </button>
          <button class="btn btn-quiet btn-sm" type="button" data-grafana>${ico("external")}Grafana SSO</button>
        </div>
        <p class="card-note">Start/stop goes through the narrow write proxy. If the stack was never deployed the API answers <span class="mono">409 monitoring_not_deployed</span>; the console then shows the compose command instead of a dead switch.</p>
      </section>

      <section class="card">
        ${cardHead("Redis", D.REDIS.reachable ? `${D.REDIS.latency_ms} ms` : "unreachable", `<span class="badge ${D.REDIS.reachable ? "is-good" : "is-bad"}">${D.REDIS.reachable ? "reachable" : "down"}</span>`)}
        <div class="redis-grid">
          <div><span>Server</span><strong class="mono">${esc(D.REDIS.server.version)} · ${esc(D.REDIS.server.mode)}</strong></div>
          <div><span>Memory</span><strong class="mono">${esc(D.REDIS.memory.used_human)} / 256M</strong></div>
          <div><span>Clients</span><strong class="mono">${D.REDIS.clients.connected} connected</strong></div>
          <div><span>Workers</span><strong class="mono">${D.REDIS.workers.alive}/${D.REDIS.workers.expected} alive</strong></div>
          <div><span>Pub/Sub</span><strong class="mono">${D.REDIS.pubsub.pattern_subscriptions} patterns</strong></div>
          <div><span>Keys</span><strong class="mono">${num(D.REDIS.keyspace[0].keys)}</strong></div>
        </div>
        <div class="redis-workers">
          ${D.REDIS.workers.items.map((w) => `<span class="worker-dot" title="pid ${w.pid} · ${w.jobs} jobs"><span class="lamp is-good"></span><span class="mono">${w.pid}</span></span>`).join("")}
          <span class="fine">heartbeat registry · no mismatch</span>
        </div>
        <div class="redis-degrade">
          <span class="badge is-good">no degradation</span>
          <span class="fine"><span class="mono">${num(D.REDIS.degradation.bus_published)}</span> bus publishes · <span class="mono">0</span> failures · <span class="mono">${num(D.REDIS.stats.expired_keys)}</span> expired keys</span>
        </div>
      </section>
    </div>

    <section class="card">
      ${cardHead("Instance control", "dangerous · audited", '<span class="badge is-outline">admin</span>')}
      <div class="danger-row">
        <div>
          <strong>Restart the application</strong>
          <span>Graceful drain, then every worker boots again. In-flight requests may see a short 503.</span>
        </div>
        <button class="btn btn-quiet btn-sm" type="button" data-admin-action="restart">${ico("refresh")}Restart</button>
      </div>
      <div class="danger-row">
        <div>
          <strong>Shut the instance down</strong>
          <span>Stops the API process. This console cannot bring it back — that needs a shell.</span>
        </div>
        <button class="btn btn-danger btn-sm" type="button" data-admin-action="shutdown">${ico("x-circle")}Shut down</button>
      </div>
      <p class="card-note">Both endpoints accept an admin, or debug mode from loopback. Neither is a soft reset: sessions and agent streams drop.</p>
    </section>`;
  }

  /* -------------------------------------------------------------- access */

  function accessMarkup() {
    const admins = D.USERS.filter((u) => u.role === "admin");
    const members = D.USERS.filter((u) => u.role !== "admin");
    return `${sectionHead(
      "Govern",
      "Access",
      "Who can reach this instance and what they can do inside it. Global admin is one bit on the user record; repository roles live on memberships and are managed from each repository.",
      `<button class="btn btn-ghost btn-sm" type="button" data-toast="User creation is POST /api/v1/users; the invite mailer is outside this prototype.">${ico("plus")}Create user</button>`
    )}

    <section class="card acl-card">
      ${cardHead("Gateway allowlist", "KUSTOS_ADMIN_ALLOWED_SOURCES", `<span class="badge ${D.ACL.sources.length ? "is-warn" : "is-bad"}">${D.ACL.sources.length} source${D.ACL.sources.length === 1 ? "" : "s"}</span>`)}
      <div class="acl-body">
        <div class="acl-sources">
          ${D.ACL.sources.map((source) => `<span class="acl-chip"><span class="mono">${esc(source)}</span><button type="button" class="acl-remove" data-acl-remove="${esc(source)}" aria-label="Remove ${esc(source)}">${ico("x", "icon-xs")}</button></span>`).join("")}
          <form class="acl-add" id="acl-add">
            <input class="input" id="acl-input" type="text" placeholder="10.30.0.0/16" aria-label="Add allowed source" autocomplete="off" spellcheck="false">
            <button class="btn btn-quiet btn-sm" type="submit">${ico("plus")}Add</button>
          </form>
        </div>
        <div class="acl-facts">
          <div><span>Gated paths</span><span class="mono">^~ /api/app/ · /grafana</span></div>
          <div><span>Empty list</span><span class="acl-warn">denies every source</span></div>
          <div><span>Evaluated at</span><span>gateway · <span class="mono">admin_acl.lua</span></span></div>
          <div><span>Last change</span><span>${esc(D.ACL.updated_at)} · ${esc(D.ACL.updated_by)}</span></div>
        </div>
      </div>
      <p class="card-note">The allowlist is environment configuration, not an API. Editing it needs a gateway reload — the console can validate the list but cannot write it, and says so instead of pretending.</p>
    </section>

    <section class="card">
      ${cardHead("Users", `${D.USERS.length} accounts`, `
        <div class="chip-row" role="group" aria-label="Filter users">
          ${[["all", "All"], ["admin", "Admins"], ["disabled", "Disabled"]].map(([key, label]) =>
            `<button class="chip${state.userFilter === key ? " is-active" : ""}" type="button" data-user-filter="${key}">${label}</button>`
          ).join("")}
        </div>
        <label class="search-inline">
          ${ico("search", "icon-xs")}
          <input class="input" id="user-search" type="search" placeholder="Name or handle" value="${esc(state.userQuery)}" aria-label="Search users">
        </label>
      `)}
      <div class="tbl-scroll">
      <table class="tbl user-table">
        <thead><tr><th>Account</th><th>Global role</th><th>Status</th><th>Last active</th><th class="col-num">Repos</th><th class="col-chev"></th></tr></thead>
        <tbody id="user-body">${userRowsMarkup(admins, members)}</tbody>
      </table>
      </div>
      <p class="card-foot-note" id="user-foot">${userFootMarkup()}</p>
    </section>

    <section class="card">
      ${cardHead("Role gate", "what a member sees", '<span class="badge is-outline">preview</span>')}
      <div class="gate-compare">
        <div class="gate-col">
          <p class="gate-key">Global admin</p>
          <ul>
            <li>${ico("check", "icon-xs")} Instance pill and admin console entry in the sidebar</li>
            <li>${ico("check", "icon-xs")} <span class="mono">/api/app/*</span> — status, components, config, audit, logs</li>
            <li>${ico("check", "icon-xs")} Restart, shutdown, monitoring toggle, log cleanup</li>
          </ul>
        </div>
        <div class="gate-col is-muted">
          <p class="gate-key">Member</p>
          <ul>
            <li>${ico("x", "icon-xs")} No instance health anywhere in the chrome</li>
            <li>${ico("x", "icon-xs")} <span class="mono">/api/app/*</span> answers <span class="mono">403</span>, <span class="mono">/ws/logs</span> closes 1008</li>
            <li>${ico("check", "icon-xs")} Keeps repository read/write according to membership</li>
          </ul>
        </div>
      </div>
      <div class="gate-actions">
        <a class="btn btn-quiet btn-sm" href="admin.html?as=member">${ico("eye")}Open the member view</a>
        <span class="fine">Admin-only data is removed from the chrome, not just hidden behind a tooltip.</span>
      </div>
    </section>`;
  }

  function userRowsMarkup(admins, members) {
    const query = state.userQuery.trim().toLowerCase();
    const matches = (user) => !query || `${user.name} ${user.handle} ${user.email}`.toLowerCase().includes(query);
    const visible = (list) => list.filter(matches).filter((user) => {
      if (state.userFilter === "admin") return user.role === "admin";
      if (state.userFilter === "disabled") return user.status === "disabled";
      return true;
    });
    const adminsVisible = state.userFilter === "member" ? [] : visible(admins);
    const membersVisible = visible(members);
    const groups = [
      { label: "Administrators", list: adminsVisible },
      { label: "Members", list: membersVisible }
    ].filter((group) => group.list.length);

    if (!groups.length) {
      return '<tr><td colspan="6"><div class="tbl-empty">No account matches this filter.</div></td></tr>';
    }

    return groups.map((group) => `<tr class="tbl-group"><td colspan="6"><span class="tbl-group-label">${group.label}</span><span class="tbl-group-note">${group.list.length}</span></td></tr>` +
      group.list.map((user) => `<tr class="is-clickable${user.status === "disabled" ? " is-quiet" : ""}" data-user="${user.id}">
        <td>
          <span class="user-cell">
            <span class="avatar avatar-sm ${user.bot ? "is-bot" : user.role === "admin" ? "is-amber" : "is-slate"}" aria-hidden="true">${user.bot ? ico("agent", "icon-xs") : esc(user.name.split(" ").map((p) => p[0]).join("").slice(0, 2))}</span>
            <span class="user-cell-copy">
              <span class="user-cell-name">${esc(user.name)}${user.bot ? ' <span class="badge is-mono">bot</span>' : ""}</span>
              <span class="user-cell-mail mono">${esc(user.email)}</span>
            </span>
          </span>
        </td>
        <td>${user.role === "admin" ? '<span class="badge is-warn">admin</span>' : '<span class="badge is-outline">member</span>'}</td>
        <td>${user.status === "active" ? '<span class="status-text"><span class="lamp is-good"></span>active</span>' : '<span class="status-text is-muted"><span class="lamp is-faint"></span>disabled</span>'}</td>
        <td class="mono">${esc(user.last_active)}</td>
        <td class="col-num mono">${user.repos}</td>
        <td class="col-chev">${ico("chevron-right", "icon-xs")}</td>
      </tr>`).join("")
    ).join("");
  }

  function userFootMarkup() {
    const disabled = D.USERS.filter((u) => u.status === "disabled").length;
    return `<span class="lamp is-good" aria-hidden="true"></span>${D.USERS.length - disabled} active · ${disabled} disabled`;
  }

  /* ------------------------------------------------------- configuration */

  function configMarkup() {
    const section = D.CONFIG.find((item) => item.name === state.configSection) || D.CONFIG[0];
    const totalEnv = D.CONFIG.flatMap((s) => s.keys).filter((k) => k.source === "env").length;
    const totalDb = D.CONFIG.flatMap((s) => s.keys).filter((k) => k.source === "db").length;
    const totalDefault = D.CONFIG.flatMap((s) => s.keys).filter((k) => k.source === "default").length;

    return `${sectionHead(
      "Govern",
      "Configuration",
      "Read the effective value and where it came from. Environment variables win over the database row; a write only touches the database, so an env-pinned key is shown as locked rather than editable.",
      `<button class="btn btn-quiet btn-sm" type="button" data-validate>${ico("check")}Validate</button>
       <button class="btn btn-ghost btn-sm" type="button" data-toast="Reset writes defaults for writable sections; protected sections are rejected by the API.">${ico("refresh")}Reset</button>`
    )}

    <div class="cfg-layout">
      <nav class="cfg-nav" aria-label="Configuration sections">
        ${D.CONFIG.map((item) => `<button class="cfg-nav-item${item.name === section.name ? " is-active" : ""}" type="button" data-cfg-section="${item.name}">
          <span class="cfg-nav-name">${esc(item.name)}</span>
          <span class="cfg-nav-flags">${item.writable ? "" : `<span class="cfg-lock" title="generic PUT rejected">${ico("lock", "icon-xs")}</span>`}${item.hot ? '<span class="cfg-hot">hot</span>' : ""}</span>
        </button>`).join("")}
      </nav>

      <section class="card card-flush cfg-card">
        ${cardHead(
          section.name,
          `${section.keys.length} keys · ${section.writable ? "writable" : "protected"}${section.hot ? " · hot reload" : ""}`,
          section.dedicated ? `<span class="badge is-mono">${esc(section.dedicated)}</span>` : ""
        )}
        <div class="cfg-precedence">
          <span><i class="cfg-source is-env">env</i> ${totalEnv}</span>
          <span class="cfg-precedence-arrow">›</span>
          <span><i class="cfg-source is-db">db</i> ${totalDb}</span>
          <span class="cfg-precedence-arrow">›</span>
          <span><i class="cfg-source is-default">default</i> ${totalDefault}</span>
          <span class="spacer"></span>
          <span class="fine">effective value = highest present layer</span>
        </div>
        <div class="tbl-scroll">
        <table class="tbl cfg-table">
          <thead><tr><th>Key</th><th>Value</th><th>Source</th><th>Effect</th></tr></thead>
          <tbody>
            ${section.keys.map((row) => {
              // Env beats the database row, so an env-sourced key is never editable
              // here — offering an input would be a lie about where the value lives.
              const pinned = row.locked || row.source === "env";
              const editable = section.writable && !pinned;
              return `<tr>
                <td class="mono cfg-key">${esc(row.key)}${pinned ? ` <span class="cfg-lock" title="${row.source === "env" ? "pinned by environment" : "protected key"}">${ico("lock", "icon-xs")}</span>` : ""}</td>
                <td>${editable
                  ? `<input class="cfg-input mono" data-cfg-key="${esc(section.name)}.${esc(row.key)}" value="${esc(row.value)}" aria-label="${esc(row.key)}" autocomplete="off" spellcheck="false">`
                  : `<span class="cfg-value mono">${esc(row.value)}</span>`}</td>
                <td>${sourceBadge(row.source)}</td>
                <td>${row.hot ? '<span class="badge is-good">hot</span>' : row.restart ? '<span class="badge is-warn">restart</span>' : '<span class="fine">—</span>'}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
        </div>
        <div class="cfg-foot">
          <span class="cfg-dirty" id="cfg-dirty"><span class="lamp is-good" aria-hidden="true"></span>No unsaved changes</span>
          <span class="spacer"></span>
          <span class="fine">Secrets never round-trip.</span>
          <button class="btn btn-primary btn-sm" type="button" data-save disabled>${ico("check")}Save &amp; apply</button>
        </div>
      </section>
    </div>`;
  }

  /* -------------------------------------------------------- capabilities */

  function capabilitiesMarkup() {
    const agent = D.AGENT;
    const usageMax = Math.max(...agent.usage.daily.map((d) => d.tokens));
    const search = D.SEARCH;

    return `${sectionHead(
      "Govern",
      "Capabilities",
      "Optional subsystems with their own credentials and quotas. Agent and search configuration live behind dedicated versioned endpoints, not the generic configuration writer.",
      `<span class="badge is-mono">2 subsystems</span>`
    )}

    <section class="card">
      ${cardHead(
        "Kustos agent",
        agent.enabled ? "enabled" : "disabled",
        `<label class="switch"><input type="checkbox" data-agent-toggle ${agent.enabled ? "checked" : ""}><span class="switch-track" aria-hidden="true"></span><span class="switch-label">${agent.enabled ? "Enabled" : "Disabled"}</span></label>`
      )}
      <div class="cap-grid">
        <div class="cap-field">
          <span class="cap-label">Provider</span>
          <select class="select" aria-label="Agent provider">${agent.providers.map((p) => `<option${p === agent.provider ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
        </div>
        <div class="cap-field">
          <span class="cap-label">Model</span>
          <select class="select" aria-label="Agent model"><option>gpt-4.1-mini</option><option>gpt-4.1</option><option>claude-3.5-sonnet</option></select>
        </div>
        <div class="cap-field">
          <span class="cap-label">API key</span>
          <div class="cap-key">
            <span class="badge is-good">configured</span>
            <span class="fine">source <span class="mono">db</span> · never echoed</span>
            <button class="text-link" type="button" data-toast="Replacing a key is PUT /api/app/agent/config with api_key; the response only returns key_state.">Replace</button>
          </div>
        </div>
        <div class="cap-field">
          <span class="cap-label">Connection</span>
          <div class="cap-key">
            <button class="btn btn-quiet btn-sm" type="button" data-test-agent>${ico("zap")}Test</button>
            <span class="fine" id="agent-test-state">last checked 14:51 · 214 ms</span>
          </div>
        </div>
      </div>

      <div class="quota-row">
        <div><span>Job budget</span><strong class="mono">120k</strong></div>
        <div><span>Daily budget</span><strong class="mono">2.0M</strong></div>
        <div><span>Concurrency</span><strong class="mono">3</strong></div>
        <div><span>Max steps</span><strong class="mono">24</strong></div>
        <div><span>7-day tokens</span><strong class="mono">1.48M</strong></div>
      </div>

      <div class="usage-block">
        <div class="usage-head">
          <h4>Usage · 7 days</h4>
          <span class="fine">${agent.usage.totals.jobs} jobs · ${agent.usage.totals.succeeded} succeeded · ${agent.usage.totals.failed} failed</span>
        </div>
        <div class="usage-bars">
          ${agent.usage.daily.map((day) => `<div class="usage-col" title="${day.date} · ${num(day.tokens)} tokens · ${day.jobs} jobs">
            <span class="usage-bar" style="height:${Math.max(8, Math.round((day.tokens / usageMax) * 100))}%"></span>
            <span class="usage-jobs mono">${day.jobs}</span>
            <span class="usage-day mono">${day.date.slice(8)}</span>
          </div>`).join("")}
        </div>
      </div>

      <div class="cap-tools">
        <h4>Tool calls</h4>
        ${agent.usage.tools.map((tool) => `<div class="tool-bar-row">
          <span class="mono">${esc(tool.name)}</span>
          <span class="tool-bar"><span style="width:${Math.round((tool.calls / agent.usage.tools[0].calls) * 100)}%"></span></span>
          <span class="mono tool-count">${num(tool.calls)}</span>
        </div>`).join("")}
      </div>
    </section>

    <section class="card">
      ${cardHead(
        "Search index",
        `generation ${search.current_generation} · semantic ${search.semantic_enabled ? "on" : "off"}`,
        `<button class="btn btn-quiet btn-sm" type="button" data-rebuild>${ico("refresh")}Rebuild stale</button>`
      )}
      <div class="index-totals">
        <div><span>Repositories</span><strong class="mono">${search.totals.repos}</strong></div>
        <div><span>Chunks</span><strong class="mono">${num(search.totals.chunks)}</strong></div>
        <div><span>Embeddings</span><strong class="mono">${num(search.totals.embeddings)}</strong></div>
        <div><span>Refs</span><strong class="mono">${search.totals.refs}</strong></div>
        <div><span>Stale</span><strong class="mono ${search.totals.stale ? "rose" : ""}">${search.totals.stale}</strong></div>
        <div><span>Embedding key</span><strong><span class="badge is-good">configured</span> <span class="fine mono">${esc(search.key_state.source)}</span></strong></div>
      </div>
      <div class="tbl-scroll">
      <table class="tbl index-table">
        <thead><tr><th>Repository</th><th>Head</th><th>Indexed</th><th>Chunks</th><th>Refs</th><th>Last indexed</th><th>State</th></tr></thead>
        <tbody>
          ${search.repos.map((repo) => `<tr>
            <td class="mono">${esc(repo.name)}</td>
            <td class="mono">${esc(repo.head_commit)}</td>
            <td class="mono ${repo.in_sync ? "" : "amber"}">${esc(repo.indexed_commit)}</td>
            <td class="mono">${num(repo.chunks)}</td>
            <td class="mono">${repo.refs}</td>
            <td class="mono">${esc(repo.last_indexed_at)}</td>
            <td>${repo.in_sync ? '<span class="badge is-good">in sync</span>' : '<span class="badge is-warn">2 commits behind</span>'}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      </div>
      <p class="card-foot-note">Indexing degrades to Git-tree scanning when pgvector or the embedding provider is unavailable — search still answers, semantics do not. The console states which mode is active instead of hiding it.</p>
    </section>`;
  }

  /* --------------------------------------------------------------- audit */

  function filteredAudit() {
    const f = state.audit;
    const q = f.q.trim().toLowerCase();
    return D.AUDIT.filter((row) => {
      if (f.source !== "all" && row.source !== f.source) return false;
      if (f.sensitive && !row.sensitive) return false;
      if (f.method && row.method !== f.method) return false;
      if (q) {
        const haystack = `${row.actor} ${row.path} ${row.ip} ${row.note || ""} ${row.action || ""} ${row.entity || ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  function auditMarkup() {
    const rows = filteredAudit();
    return `${sectionHead(
      "Evidence",
      "Audit log",
      "Two audit trails merged: HTTP request audit from <code>audit.log</code> and business events from the <code>activities</code> table. Querying is admin-only — a debug deployment no longer exposes it.",
      `<span class="badge is-warn">admin only</span>`
    )}

    <div class="audit-bar">
      <div class="segmented" role="group" aria-label="Audit source">
        ${[["all", "All"], ["http", "HTTP"], ["activity", "Activity"]].map(([key, label]) =>
          `<button type="button" data-audit-source="${key}" class="${state.audit.source === key ? "is-active" : ""}">${label}</button>`
        ).join("")}
      </div>
      <label class="filter-field">
        <span>Window</span>
        <select class="select" id="audit-days" aria-label="Lookback days">
          <option value="1">24 h</option>
          <option value="7" selected>7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </select>
      </label>
      <label class="filter-field">
        <span>Method</span>
        <select class="select" id="audit-method" aria-label="HTTP method">
          <option value="">Any</option>
          ${["GET", "POST", "PUT", "DELETE"].map((m) => `<option value="${m}"${state.audit.method === m ? " selected" : ""}>${m}</option>`).join("")}
        </select>
      </label>
      <label class="search-inline is-grow">
        ${ico("search", "icon-xs")}
        <input class="input" id="audit-q" type="search" placeholder="Actor, path, IP or action" value="${esc(state.audit.q)}" aria-label="Search audit">
      </label>
      <button class="chip is-toggle${state.audit.sensitive ? " is-active" : ""}" type="button" data-audit-sensitive aria-pressed="${state.audit.sensitive}">
        ${ico("shield", "icon-xs")}Sensitive only
      </button>
    </div>

    <section class="card card-flush">
      ${cardHead("Events", `<span id="audit-count">${rows.length}</span> records`, `<span class="badge is-mono">newest first</span>`)}
      <div class="tbl-scroll">
      <table class="tbl audit-table">
        <thead><tr><th>Time</th><th>Actor</th><th>Source</th><th>Action</th><th>Target</th><th>Status</th><th>IP</th></tr></thead>
        <tbody id="audit-body">${auditRowsMarkup(rows)}</tbody>
      </table>
      </div>
      <div class="audit-foot">
        <span class="lamp is-good" aria-hidden="true"></span>
        <span id="audit-foot-copy">${rows.length} of ${D.AUDIT.length} events · window 7 days</span>
        <span class="spacer"></span>
        <button class="btn btn-quiet btn-sm" type="button" data-toast="Pagination is server-side: page / limit up to 200 per page.">Previous</button>
        <span class="mono fine">1 / ${Math.max(1, Math.ceil(rows.length / 20))}</span>
        <button class="btn btn-quiet btn-sm" type="button" data-toast="Pagination is server-side: page / limit up to 200 per page.">Next</button>
      </div>
    </section>`;
  }

  function auditRowsMarkup(rows) {
    if (!rows.length) return '<tr><td colspan="7"><div class="tbl-empty">No event matches these filters.</div></td></tr>';
    return rows.map((row) => `<tr class="is-clickable${row.sensitive ? " is-sensitive" : ""}" data-audit="${row.id}">
      <td class="mono">${esc(row.at)}</td>
      <td><span class="actor">${esc(row.actor)}</span></td>
      <td><span class="badge ${row.source === "http" ? "is-outline" : "is-mono"}">${row.source}</span></td>
      <td><span class="method">${esc(row.method)}</span> <span class="mono path">${esc(row.action || row.path)}</span></td>
      <td class="mono audit-target">${esc(row.entity || "—")}</td>
      <td><span class="badge ${row.status < 400 ? "is-good" : row.status === 403 || row.status === 409 ? "is-warn" : "is-bad"}">${row.status}</span></td>
      <td class="mono">${esc(row.ip)}</td>
    </tr>`).join("");
  }

  /* ---------------------------------------------------------------- logs */

  function logLines() {
    const all = D.LOG_FILES[state.log.file] || [];
    const filtered = state.log.level === "all" ? all : all.filter((line) => line.level.toLowerCase() === state.log.level);
    return filtered.slice(-state.log.lines);
  }

  function logsMarkup() {
    const lines = logLines();
    return `${sectionHead(
      "Evidence",
      "Logs",
      "Application, error and audit files on the shared volume. Live tail rides the admin-only <code>/ws/logs</code> socket; historical reads are paginated windows, not full-file dumps.",
      `<button class="btn btn-quiet btn-sm" type="button" data-cleanup>${ico("trash")}Clean up</button>`
    )}

    <div class="log-toolbar">
      <div class="tabs" role="tablist" aria-label="Log file">
        ${["app", "error", "audit"].map((file) => `<button class="tab${state.log.file === file ? " is-active" : ""}" type="button" role="tab" aria-selected="${state.log.file === file}" data-log-file="${file}">${file}<span class="count">${(D.LOG_FILES[file] || []).length}</span></button>`).join("")}
      </div>
      <span class="spacer"></span>
      <label class="filter-field">
        <span>Date</span>
        <select class="select" id="log-date" aria-label="Log date">
          <option>2026-10-28</option>
          <option>2026-10-27</option>
          <option>2026-10-26</option>
        </select>
      </label>
      <label class="filter-field">
        <span>Lines</span>
        <select class="select" id="log-lines" aria-label="Line window">
          <option value="100">100</option>
          <option value="500">500</option>
          <option value="2000">2000</option>
        </select>
      </label>
      <label class="switch is-compact">
        <input type="checkbox" data-log-tail ${state.log.tail ? "checked" : ""}>
        <span class="switch-track" aria-hidden="true"></span>
        <span class="switch-label">Live tail</span>
      </label>
    </div>

    <div class="log-levels" role="group" aria-label="Level filter">
      ${[["all", "All"], ["debug", "Debug"], ["info", "Info"], ["warn", "Warn"], ["error", "Error"], ["audit", "Audit"]].map(([key, label]) =>
        `<button class="chip${state.log.level === key ? " is-active" : ""}" type="button" data-log-level="${key}">${label}</button>`
      ).join("")}
      <span class="spacer"></span>
      <span class="fine">${state.log.tail ? '<span class="lamp is-good is-live"></span>tailing <span class="mono">/ws/logs</span>' : '<span class="lamp is-faint"></span>paused'} · retention 14 days</span>
    </div>

    <section class="card card-flush log-card">
      <div class="log-stream" id="log-stream" role="log" aria-live="polite">
        ${lines.length
          ? lines.map(logLineMarkup).join("")
          : `<div class="log-empty">
              <span class="lamp is-faint" aria-hidden="true"></span>
              <p>No <span class="mono">${esc(state.log.level)}</span> lines in <span class="mono">${esc(state.log.file)}.log</span> over the last ${state.log.lines}.</p>
              ${state.log.file === "app" && (state.log.level === "error" || state.log.level === "warn") ? '<button class="text-link" type="button" data-log-file="error">Open error.log instead</button>' : ""}
            </div>`
        }
      </div>
      <div class="log-foot">
        <span class="mono">${state.log.file}.log</span>
        <span class="fine">last ${lines.length} lines · window covers the newest segment</span>
        <span class="spacer"></span>
        <span class="fine">truncated: <span class="mono">false</span> · segment starts <span class="mono">[0]</span></span>
      </div>
    </section>`;
  }

  function logLineMarkup(line) {
    const level = line.level.toLowerCase();
    return `<div class="log-line is-${level}">
      <span class="log-time mono">${esc(line.t)}</span>
      <span class="log-level">${esc(line.level)}</span>
      <span class="log-msg">${esc(line.msg)}</span>
      <span class="log-req mono">${esc(line.req || "—")}</span>
    </div>`;
  }

  function startTail() {
    window.clearInterval(tailTimer);
    if (state.section !== "logs" || !state.log.tail) return;
    tailTimer = window.setInterval(() => {
      const stream = document.getElementById("log-stream");
      if (!stream) return;
      const now = new Date();
      const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      const pool = [
        { level: "INFO", msg: "GET /api/v1/repositories/r-1/pulls 200 54ms user=mara" },
        { level: "INFO", msg: "ws heartbeat users=9 rooms=4 latency=2ms" },
        { level: "DEBUG", msg: `redis hit kustos:session ttl=${90 + Math.round(Math.random() * 20)}` },
        { level: "INFO", msg: "agent run A-1043 tool=search_code results=7 88ms" },
        { level: "WARN", msg: "git post-receive repo=lin/harbor 2.4s (threshold 2.0s)" }
      ];
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (state.log.level !== "all" && state.log.level !== pick.level.toLowerCase()) return;
      const row = document.createElement("div");
      row.className = `log-line is-${pick.level.toLowerCase()} is-fresh`;
      row.innerHTML = `<span class="log-time mono">${stamp}</span>
        <span class="log-level">${pick.level}</span>
        <span class="log-msg">${esc(pick.msg)}</span>
        <span class="log-req mono">live</span>`;
      stream.appendChild(row);
      while (stream.children.length > state.log.lines) stream.removeChild(stream.firstElementChild);
      stream.scrollTop = stream.scrollHeight;
    }, 2600);
  }

  /* ------------------------------------------------------------- inspect */

  function renderInspect() {
    const slot = document.getElementById("admin-inspect");
    if (!slot) return;
    const sel = state.selected;
    if (!sel) {
      slot.innerHTML = `<div class="inspect-empty">
        <svg class="icon" aria-hidden="true"><use href="#i-search"></use></svg>
        <strong>Nothing selected</strong>
        <span>Pick a component, an account or an audit row. The panel keeps its place while you move through the canvas.</span>
      </div>`;
      return;
    }

    if (sel.kind === "component") {
      const c = D.COMPONENTS.find((item) => item.service === sel.id);
      if (!c) return;
      slot.innerHTML = `<h3>${esc(c.label)}</h3>
        <p class="inspect-sub mono">${esc(c.service)}</p>
        <dl class="kv compact">
          <div class="kv-row"><dt class="kv-key">State</dt><dd class="kv-val">${stateBadge(c)}</dd></div>
          <div class="kv-row"><dt class="kv-key">Image</dt><dd class="kv-val is-mono">${esc(c.image)}</dd></div>
          <div class="kv-row"><dt class="kv-key">Started</dt><dd class="kv-val is-mono">${esc(c.started_at.replace("T", " ").replace("Z", "Z"))}</dd></div>
          <div class="kv-row"><dt class="kv-key">Uptime</dt><dd class="kv-val">${uptime(c.uptime_seconds)}</dd></div>
          <div class="kv-row"><dt class="kv-key">Restarts</dt><dd class="kv-val">${c.restart_count}</dd></div>
          <div class="kv-row"><dt class="kv-key">Exit code</dt><dd class="kv-val is-mono">${c.exit_code === null ? "—" : c.exit_code}</dd></div>
          <div class="kv-row"><dt class="kv-key">Ports</dt><dd class="kv-val is-mono">${esc(c.ports)}</dd></div>
        </dl>
        <p class="inspect-note">${esc(c.status_text)}</p>
        <div class="inspect-actions">
          <button class="btn btn-quiet btn-sm" type="button" data-copy="${esc(c.service)}" data-copy-label="Service copied">${ico("copy")}Copy service</button>
          <button class="btn btn-quiet btn-sm" type="button" data-goto="logs">${ico("terminal")}View logs</button>
          <button class="btn btn-quiet btn-sm" type="button" data-inspect-action="restart-component" data-target="${esc(c.service)}">${ico("refresh")}Restart</button>
        </div>`;
      setPanelHead("Component", c.service);
      return;
    }

    if (sel.kind === "user") {
      const u = D.USERS.find((item) => item.id === sel.id);
      if (!u) return;
      slot.innerHTML = `<p class="inspect-sub is-lead mono">@${esc(u.handle)} · ${esc(u.email)}</p>
        <dl class="kv compact">
          <div class="kv-row"><dt class="kv-key">Global role</dt><dd class="kv-val">${u.role === "admin" ? '<span class="badge is-warn">admin</span>' : '<span class="badge is-outline">member</span>'}</dd></div>
          <div class="kv-row"><dt class="kv-key">Status</dt><dd class="kv-val">${u.status}</dd></div>
          <div class="kv-row"><dt class="kv-key">Repositories</dt><dd class="kv-val">${u.repos} memberships</dd></div>
          <div class="kv-row"><dt class="kv-key">Last active</dt><dd class="kv-val">${esc(u.last_active)}</dd></div>
          <div class="kv-row"><dt class="kv-key">Joined</dt><dd class="kv-val mono">${esc(u.joined)}</dd></div>
        </dl>
        <p class="inspect-note">Global admin and repository ownership are separate grants. A repo role (owner/admin/developer/readonly) never follows from the admin bit.</p>
        <div class="inspect-actions">
          <button class="btn btn-quiet btn-sm" type="button" data-inspect-action="reset-password" data-target="${esc(u.id)}">${ico("key")}Reset password</button>
          <button class="btn btn-quiet btn-sm" type="button" data-inspect-action="${u.role === "admin" ? "revoke-admin" : "grant-admin"}" data-target="${esc(u.id)}">${ico("shield")}${u.role === "admin" ? "Revoke admin" : "Grant admin"}</button>
          <button class="btn btn-quiet btn-sm" type="button" data-inspect-action="${u.status === "active" ? "disable-user" : "enable-user"}" data-target="${esc(u.id)}">${ico("lock")}${u.status === "active" ? "Disable" : "Enable"}</button>
          <button class="btn btn-danger btn-sm" type="button" data-inspect-action="delete-user" data-target="${esc(u.id)}">${ico("trash")}Delete</button>
        </div>`;
      setPanelHead("Account", u.name);
      return;
    }

    if (sel.kind === "audit") {
      const row = D.AUDIT.find((item) => item.id === sel.id);
      if (!row) return;
      slot.innerHTML = `<h3>${esc(row.method)} <span class="inspect-path mono">${esc(row.path)}</span></h3>
        <p class="inspect-sub">${esc(row.source)} · client <span class="mono">${esc(row.ip)}</span></p>
        <dl class="kv compact">
          <div class="kv-row"><dt class="kv-key">Status</dt><dd class="kv-val"><span class="badge ${row.status < 400 ? "is-good" : row.status === 403 || row.status === 409 ? "is-warn" : "is-bad"}">${row.status}</span></dd></div>
          <div class="kv-row"><dt class="kv-key">Client IP</dt><dd class="kv-val mono">${esc(row.ip)}</dd></div>
          <div class="kv-row"><dt class="kv-key">Request ID</dt><dd class="kv-val mono">${esc(row.request_id)}</dd></div>
          <div class="kv-row"><dt class="kv-key">User agent</dt><dd class="kv-val">${esc(row.ua)}</dd></div>
          <div class="kv-row"><dt class="kv-key">Sensitive</dt><dd class="kv-val">${row.sensitive ? '<span class="badge is-warn">yes</span>' : "no"}</dd></div>
          ${row.entity ? `<div class="kv-row"><dt class="kv-key">Entity</dt><dd class="kv-val mono">${esc(row.entity)}</dd></div>` : ""}
          ${row.action ? `<div class="kv-row"><dt class="kv-key">Action</dt><dd class="kv-val mono">${esc(row.action)}</dd></div>` : ""}
        </dl>
        ${row.note ? `<p class="inspect-note">${esc(row.note)}</p>` : ""}
        <div class="inspect-actions">
          <button class="btn btn-quiet btn-sm" type="button" data-copy="${esc(row.request_id)}" data-copy-label="Request ID copied">${ico("copy")}Copy request ID</button>
          <button class="btn btn-quiet btn-sm" type="button" data-goto="logs">${ico("terminal")}Related logs</button>
        </div>`;
      setPanelHead("Audit event", `${row.actor} · ${row.at}`);
    }
  }

  function setPanelHead(kicker, title) {
    const panel = stage.querySelector(".float-panel");
    if (!panel) return;
    const k = panel.querySelector(".float-head .eyebrow");
    const h = panel.querySelector(".float-head h2");
    if (k) k.textContent = kicker;
    if (h) h.textContent = title;
    // Keep the dock in sync so closing and reopening lands on the same heading.
    const dock = stage.querySelector('[data-panel-tab="inspect"]');
    if (dock) {
      dock.dataset.panelLabel = title;
      dock.dataset.panelKicker = kicker;
    }
  }

  function renderApiPanel() {
    const slot = document.getElementById("admin-api");
    if (!slot) return;
    const rows = D.API_MAP[state.section] || [];
    slot.innerHTML = `<p class="inspect-sub is-lead">${esc(SECTIONS.find((s) => s.id === state.section).label)} · ${rows.length} endpoints</p>
      <div class="api-list">
        ${rows.map((row) => `<div class="api-row">
          <span class="api-method is-${row.m.toLowerCase()}">${esc(row.m)}</span>
          <div class="api-copy">
            <span class="api-path mono">${esc(row.p)}</span>
            <span class="api-note">${esc(row.note)}</span>
          </div>
          <span class="api-guard">${esc(row.guard)}</span>
        </div>`).join("")}
      </div>
      <p class="inspect-note">Full schema: <span class="mono">/openapi.json</span>. Error bodies carry <span class="mono">error.error_code</span> for stable branching.</p>`;
  }

  /* -------------------------------------------------------------- render */

  const RENDERERS = {
    overview: overviewMarkup,
    runtime: runtimeMarkup,
    access: accessMarkup,
    configuration: configMarkup,
    capabilities: capabilitiesMarkup,
    audit: auditMarkup,
    logs: logsMarkup
  };

  /* Keep the inspector below the header as the header wraps. */
  function syncPanelTop() {
    if (!stage || !core) return;
    const gate = core.querySelector(".admin-gate");
    if (!gate) return;
    const stageTop = stage.getBoundingClientRect().top;
    const offset = Math.round(gate.getBoundingClientRect().bottom - stageTop + 10);
    stage.style.setProperty("--admin-panel-top", `${offset}px`);
  }

  function render() {
    canvas.innerHTML = RENDERERS[state.section]();
    U.qsa("[data-section]", rail).forEach((button) => {
      const active = button.dataset.section === state.section;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    // The rail badge tracks the one thing Runtime can fix from here.
    const runtimeBadge = document.querySelector("[data-runtime-count]");
    if (runtimeBadge) {
      const pending = state.monitoringRunning ? 0 : 1;
      runtimeBadge.textContent = String(pending);
      runtimeBadge.hidden = pending === 0;
      runtimeBadge.classList.toggle("is-warn", pending > 0);
    }
    renderInspect();
    renderApiPanel();
    if (state.section === "overview") bindChart();
    if (state.section === "configuration") syncDirty();
    startTail();
    if (typeof syncCanvasEdge === "function") window.setTimeout(syncCanvasEdge, 0);
    window.clearTimeout(render._scroll);
    render._scroll = window.setTimeout(() => {
      canvas.scrollTop = 0;
    }, 0);
  }

  function go(section) {
    if (!SECTIONS.some((s) => s.id === section)) return;
    if (state.section === "configuration" && state.dirty.size) {
      K.toast("Unsaved configuration changes were discarded.", { tone: "warn", title: "Section changed" });
      state.dirty.clear();
    }
    K.closePanel(stage);
    state.section = section;
    render();
    // Section navigation behaves like tabs: move reading position to the canvas.
    canvas.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------ interact */

  function select(kind, id) {
    state.selected = { kind, id };
    K.openPanel(stage, "inspect");
    renderInspect();
  }

  function confirmAction(config) {
    document.getElementById("admin-modal-kicker").textContent = config.kicker || "Privileged action";
    document.getElementById("admin-modal-title").textContent = config.title;
    document.getElementById("admin-modal-desc").textContent = config.desc || "";
    document.getElementById("admin-modal-body").innerHTML = config.body || "";
    const go = document.getElementById("admin-modal-go");
    go.textContent = config.label || "Confirm";
    go.className = `btn ${config.danger === false ? "btn-primary" : "btn-danger"}`;
    // A dangerous action needs an explicit acknowledgement, not just a click.
    const ack = document.querySelector("#admin-modal-body input[type=checkbox]");
    go.disabled = Boolean(ack) && !ack.checked;
    if (ack) {
      ack.addEventListener("change", () => {
        go.disabled = !ack.checked;
      });
    }
    pendingConfirm = config.onConfirm;
    K.openModal("admin-modal");
  }

  document.getElementById("admin-confirm").addEventListener("submit", (event) => {
    event.preventDefault();
    const fn = pendingConfirm;
    pendingConfirm = null;
    K.closeModal("admin-modal");
    if (fn) fn();
  });

  document.addEventListener("click", (event) => {
    const sectionButton = event.target.closest("[data-section]");
    if (sectionButton) {
      go(sectionButton.dataset.section);
      return;
    }

    const goto = event.target.closest("[data-goto]");
    if (goto) {
      event.preventDefault();
      go(goto.dataset.goto);
      return;
    }

    const range = event.target.closest("[data-range]");
    if (range) {
      state.range = range.dataset.range;
      render();
      return;
    }

    const comp = event.target.closest("[data-comp]");
    if (comp) {
      select("component", comp.dataset.comp);
      return;
    }

    const user = event.target.closest("[data-user]");
    if (user) {
      select("user", user.dataset.user);
      return;
    }

    const auditRow = event.target.closest("[data-audit]");
    if (auditRow) {
      select("audit", auditRow.dataset.audit);
      return;
    }

    const userFilter = event.target.closest("[data-user-filter]");
    if (userFilter) {
      state.userFilter = userFilter.dataset.userFilter;
      render();
      return;
    }

    const cfgSection = event.target.closest("[data-cfg-section]");
    if (cfgSection) {
      if (state.dirty.size) {
        K.toast("Unsaved changes were discarded.", { tone: "warn", title: "Section changed" });
      }
      state.configSection = cfgSection.dataset.cfgSection;
      state.dirty.clear();
      render();
      return;
    }

    if (event.target.closest("[data-validate]")) {
      K.toast("Configuration validates: 2 hints would need a restart.", { tone: "good", title: "Validation passed" });
      return;
    }

    if (event.target.closest("[data-save]")) {
      const count = state.dirty.size;
      if (!count) return;
      state.dirty.forEach((value, path) => {
        const [section, key] = path.split(".");
        const target = D.CONFIG.find((item) => item.name === section);
        const row = target && target.keys.find((k) => k.key === key);
        if (row) {
          row.value = value;
          row.source = "db";
        }
      });
      state.dirty.clear();
      render();
      K.toast(`${count} value${count === 1 ? "" : "s"} written to app_config. Restart-flagged keys take effect after the next boot.`, {
        tone: "good", title: "Configuration saved"
      });
      return;
    }

    const monToggle = event.target.closest("[data-mon-toggle]");
    if (monToggle) {
      const starting = !state.monitoringRunning;
      confirmAction({
        kicker: "Optional stack",
        title: starting ? "Start Prometheus and Grafana" : "Stop Prometheus and Grafana",
        desc: starting
          ? "Both containers were created previously, so the write proxy can start them. Metrics collection continues during the boot."
          : "Grafana SSO will stop working immediately; in-process metrics keep recording.",
        body: `<label class="check"><input type="checkbox"><span>I understand this touches the observability stack only, not the app.</span></label>`,
        label: starting ? "Start stack" : "Stop stack",
        danger: !starting,
        onConfirm: () => {
          state.monitoringRunning = starting;
          render();
          K.toast(starting ? "Monitoring stack starting — Grafana ready in ~8s." : "Monitoring stack stopped.", {
            tone: starting ? "good" : "warn",
            title: starting ? "Stack starting" : "Stack stopped"
          });
        }
      });
      return;
    }

    if (event.target.closest("[data-grafana]")) {
      if (!state.monitoringRunning) {
        K.toast("Grafana is not running. Start the monitoring stack first.", { tone: "warn", title: "Grafana unavailable" });
        return;
      }
      K.toast("Session cookie set; opening /grafana.", { tone: "good", title: "Grafana SSO" });
      return;
    }

    const action = event.target.closest("[data-admin-action]");
    if (action) {
      const kind = action.dataset.adminAction;
      if (kind === "restart") {
        confirmAction({
          kicker: "Dangerous",
          title: "Restart the application",
          desc: "All four workers restart. In-flight requests may see a short 503 window; agent jobs resume from their checkpoint.",
          body: `<label class="check"><input type="checkbox" id="admin-confirm-check"><span>I understand this interrupts every session for a few seconds.</span></label>
                 <p class="field-hint">Audited as <span class="mono">POST /api/app/restart</span> with your user id.</p>`,
          label: "Restart",
          onConfirm: () => K.toast("Restart scheduled. Workers drain, then boot.", { tone: "warn", title: "Restart queued" })
        });
      } else {
        confirmAction({
          kicker: "Dangerous",
          title: "Shut the instance down",
          desc: "The API stops accepting connections. Bring it back with the CLI; this console cannot restart a stopped process.",
          body: `<label class="check"><input type="checkbox"><span>I have shell access to run <span class="mono">mgt.sh start</span>.</span></label>`,
          label: "Shut down",
          onConfirm: () => K.toast("Shutdown requested. This console will lose its backend.", { tone: "bad", title: "Shutdown sent" })
        });
      }
      return;
    }

    const inspectAction = event.target.closest("[data-inspect-action]");
    if (inspectAction) {
      const kind = inspectAction.dataset.inspectAction;
      const target = inspectAction.dataset.target;
      const user = D.USERS.find((u) => u.id === target);
      const comp = D.COMPONENTS.find((c) => c.service === target);
      if (kind === "restart-component") {
        confirmAction({
          kicker: "Component",
          title: `Restart ${target}`,
          desc: "This restarts one container through the write proxy. Dependent services may drop a request during the restart.",
          body: `<label class="check"><input type="checkbox"><span>Restart <span class="mono">${esc(target)}</span> now.</span></label>`,
          label: "Restart container",
          onConfirm: () => K.toast(`${target} restart requested.`, { tone: "warn", title: "Container restart" })
        });
        return;
      }
      if (kind === "reset-password") {
        K.toast(`One-time password issued for ${user.name}. It is shown once and never stored in clear.`, { tone: "good", title: "Password reset" });
        return;
      }
      if (kind === "grant-admin" || kind === "revoke-admin") {
        const grant = kind === "grant-admin";
        confirmAction({
          kicker: "Global role",
          title: `${grant ? "Grant" : "Revoke"} global admin`,
          desc: grant ? "Global admin bypasses repository permission checks and reaches /api/app/*." : "The account keeps its repository memberships but loses every instance-level surface.",
          body: `<label class="check"><input type="checkbox"><span>${grant ? "Grant" : "Revoke"} <span class="mono">is_admin</span> for ${esc(user.name)}.</span></label>`,
          label: grant ? "Grant admin" : "Revoke admin",
          danger: grant,
          onConfirm: () => {
            D.USERS.forEach((u) => {
              if (u.id === user.id) u.role = grant ? "admin" : "member";
            });
            render();
            K.toast(`${user.name} is ${grant ? "now" : "no longer"} a global admin.`, { tone: grant ? "warn" : "info", title: "Role updated" });
          }
        });
        return;
      }
      if (kind === "disable-user" || kind === "enable-user") {
        const disable = kind === "disable-user";
        confirmAction({
          kicker: "Account",
          title: `${disable ? "Disable" : "Enable"} ${user.name}`,
          desc: disable ? "Existing access tokens stop validating on the next request; refresh tokens are revoked." : "The account can sign in again with its existing password.",
          body: `<label class="check"><input type="checkbox"><span>Set <span class="mono">is_active=${!disable}</span>.</span></label>`,
          label: disable ? "Disable account" : "Enable account",
          onConfirm: () => {
            user.status = disable ? "disabled" : "active";
            render();
            K.toast(`${user.name} ${disable ? "disabled" : "enabled"}.`, { tone: disable ? "warn" : "good", title: "Account updated" });
          }
        });
        return;
      }
      if (kind === "delete-user") {
        K.toast("Hard delete is intentionally not simulated. The API exists; the prototype stops here.", { tone: "bad", title: "Not in prototype" });
        return;
      }
      return;
    }

    if (event.target.closest("[data-test-agent]")) {
      const stateNode = document.getElementById("agent-test-state");
      if (stateNode) stateNode.textContent = "testing…";
      window.setTimeout(() => {
        const node = document.getElementById("agent-test-state");
        if (node) node.textContent = "ok · 198 ms · 1 model";
        K.toast("Provider answered with 1 available model.", { tone: "good", title: "Connection ok" });
      }, 700);
      return;
    }

    if (event.target.closest("[data-rebuild]")) {
      K.toast("Reindex queued for lin/harbor (2 commits behind).", { tone: "good", title: "Reindex queued" });
      return;
    }

    if (event.target.closest("[data-cleanup]")) {
      confirmAction({
        kicker: "Logs",
        title: "Delete logs older than 14 days",
        desc: "cleanup keeps the retention window and deletes older date directories. Audit rows in the database are untouched.",
        body: `<label class="check"><input type="checkbox"><span>Keep 14 days, delete 31 files.</span></label>`,
        label: "Delete 31 files",
        onConfirm: () => K.toast("31 files removed · 14 days retained.", { tone: "warn", title: "Logs cleaned" })
      });
      return;
    }

    const auditSource = event.target.closest("[data-audit-source]");
    if (auditSource) {
      state.audit.source = auditSource.dataset.auditSource;
      refreshAudit();
      U.qsa("[data-audit-source]").forEach((button) => button.classList.toggle("is-active", button.dataset.auditSource === state.audit.source));
      return;
    }

    if (event.target.closest("[data-audit-sensitive]")) {
      state.audit.sensitive = !state.audit.sensitive;
      const button = event.target.closest("[data-audit-sensitive]");
      button.classList.toggle("is-active", state.audit.sensitive);
      button.setAttribute("aria-pressed", String(state.audit.sensitive));
      refreshAudit();
      return;
    }

    const logFile = event.target.closest("[data-log-file]");
    if (logFile) {
      state.log.file = logFile.dataset.logFile;
      render();
      return;
    }

    const logLevel = event.target.closest("[data-log-level]");
    if (logLevel) {
      state.log.level = logLevel.dataset.logLevel;
      render();
      return;
    }

    const aclRemove = event.target.closest("[data-acl-remove]");
    if (aclRemove) {
      const source = aclRemove.dataset.aclRemove;
      confirmAction({
        kicker: "Gateway ACL",
        title: `Remove ${source}?`,
        desc: "This list is honoured by admin_acl.lua. Removing the last source denies every request to /api/app/* and /grafana.",
        body: `<label class="check"><input type="checkbox"><span>Remove <span class="mono">${esc(source)}</span> from the allowlist.</span></label>`,
        label: "Remove source",
        onConfirm: () => {
          D.ACL.sources = D.ACL.sources.filter((item) => item !== source);
          render();
          K.toast("Allowlist updated in the prototype; apply with a gateway reload.", { tone: "warn", title: "ACL changed" });
        }
      });
      return;
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "user-search") {
      state.userQuery = event.target.value;
      updateUserBody();
      return;
    }

    if (event.target.id === "audit-q") {
      state.audit.q = event.target.value;
      refreshAudit();
      return;
    }

    const cfgKey = event.target.closest("[data-cfg-key]");
    if (cfgKey) {
      state.dirty.set(cfgKey.dataset.cfgKey, cfgKey.value);
      syncDirty();
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "audit-days") {
      state.audit.days = Number(event.target.value);
      refreshAudit();
      return;
    }
    if (event.target.id === "audit-method") {
      state.audit.method = event.target.value;
      refreshAudit();
      return;
    }
    if (event.target.id === "log-date") {
      state.log.date = event.target.value;
      K.toast(`Loading ${event.target.value} · ${state.log.file}.log`, { title: "Log window" });
      return;
    }
    if (event.target.id === "log-lines") {
      state.log.lines = Number(event.target.value);
      render();
      return;
    }
    if (event.target.matches("[data-log-tail]")) {
      state.log.tail = event.target.checked;
      render();
      return;
    }
    if (event.target.matches("[data-agent-toggle]")) {
      D.AGENT.enabled = event.target.checked;
      render();
      K.toast(`Agent ${D.AGENT.enabled ? "enabled" : "disabled"}. Enabling also provisions the bot account.`, {
        tone: D.AGENT.enabled ? "good" : "warn", title: "Agent configuration"
      });
    }
  });

  document.addEventListener("submit", (event) => {
    if (event.target.id !== "acl-add") return;
    event.preventDefault();
    const input = document.getElementById("acl-input");
    const value = (input.value || "").trim();
    if (!/^[0-9a-fA-F:.]+\/?\d{0,2}$/.test(value)) {
      K.toast("Use an IPv4/IPv6 address or CIDR, e.g. 10.30.0.0/16.", { tone: "bad", title: "Invalid source" });
      return;
    }
    if (D.ACL.sources.includes(value)) {
      K.toast("That source is already allowed.", { tone: "warn", title: "Duplicate" });
      return;
    }
    D.ACL.sources.push(value);
    render();
    K.toast("Added to the allowlist. Reload the gateway to enforce it.", { tone: "good", title: "Source added" });
  });

  function updateUserBody() {
    const body = document.getElementById("user-body");
    const foot = document.getElementById("user-foot");
    if (!body) return;
    const admins = D.USERS.filter((u) => u.role === "admin");
    const members = D.USERS.filter((u) => u.role !== "admin");
    body.innerHTML = userRowsMarkup(admins, members);
    if (foot) foot.innerHTML = userFootMarkup();
  }

  function refreshAudit() {
    const rows = filteredAudit();
    const body = document.getElementById("audit-body");
    const count = document.getElementById("audit-count");
    const foot = document.getElementById("audit-foot-copy");
    if (body) body.innerHTML = auditRowsMarkup(rows);
    if (count) count.textContent = rows.length;
    if (foot) foot.textContent = `${rows.length} of ${D.AUDIT.length} events · window ${state.audit.days} days`;
  }

  function syncDirty() {
    const count = state.dirty.size;
    const slot = document.getElementById("cfg-dirty");
    const save = document.querySelector("[data-save]");
    if (slot) {
      slot.innerHTML = count
        ? `<span class="lamp is-warn" aria-hidden="true"></span>${count} unsaved change${count === 1 ? "" : "s"}`
        : '<span class="lamp is-good" aria-hidden="true"></span>No unsaved changes';
      slot.classList.toggle("is-dirty", count > 0);
    }
    if (save) save.disabled = count === 0;
  }

  /* ---------------------------------------------------------------- boot */

  function renderDenied() {
    document.querySelector(".float-dock").remove();
    document.querySelector(".float-panel").remove();
    core.innerHTML = `<div class="admin-denied">
      <span class="denied-mark" aria-hidden="true">${ico("shield")}</span>
      <p class="eyebrow">Instance · Northstar Labs</p>
      <h1 class="display-sm">This surface is admin-only.</h1>
      <p class="lede">Your session is valid, but <code>User.is_admin</code> is false. <code>/api/app/status</code> answered <code>403 app_admin_or_debug_required</code>, so the console has nothing it is allowed to load.</p>
      <dl class="kv denied-facts">
        <div class="kv-row"><dt class="kv-key">Request</dt><dd class="kv-val mono">GET /api/app/status</dd></div>
        <div class="kv-row"><dt class="kv-key">Gate</dt><dd class="kv-val">gateway allowlist → <span class="mono">get_current_admin_user</span></dd></div>
        <div class="kv-row"><dt class="kv-key">Decision</dt><dd class="kv-val"><span class="badge is-warn">403</span> not an administrator</dd></div>
        <div class="kv-row"><dt class="kv-key">Audit</dt><dd class="kv-val">recorded as a denied admin request</dd></div>
      </dl>
      <div class="denied-actions">
        <a class="btn btn-primary" href="index.html">${ico("home")}Back to overview</a>
        <a class="btn btn-quiet" href="login.html">${ico("arrow-up-right")}Sign in as another account</a>
        <button class="btn btn-quiet" type="button" data-toast="Access requests go to an instance admin — there is no self-serve grant.">${ico("message")}Request access</button>
      </div>
      <p class="fine denied-note">Prototype state: this is the member view (<span class="mono">?as=member</span>). The admin build hides this screen and shows the console instead.</p>
    </div>`;
  }

  if (!IS_ADMIN) {
    renderDenied();
    return;
  }

  U.qsa("[data-rail-version]").forEach((node) => {
    node.textContent = D.INSTANCE.version;
  });
  U.qsa("[data-rail-uptime]").forEach((node) => {
    node.textContent = D.INSTANCE.uptime_formatted;
  });
  U.qsa("[data-user-count]").forEach((node) => {
    node.textContent = D.USERS.length;
  });

  const layout = document.querySelector(".admin-layout");

  function syncCanvasEdge() {
    if (!layout) return;
    const atEnd = canvas.scrollTop + canvas.clientHeight >= canvas.scrollHeight - 4;
    layout.classList.toggle("is-scrolled-end", atEnd);
  }

  canvas.addEventListener("scroll", syncCanvasEdge);

  render();
  syncPanelTop();
  syncCanvasEdge();
  window.addEventListener("resize", syncPanelTop);

  console.assert(D.COMPONENTS.length === D.COMPONENT_SUMMARY.total, "Admin: component total matches summary");
  console.assert(!!D.API_MAP[state.section], "Admin: API map covers the first section");
})();
