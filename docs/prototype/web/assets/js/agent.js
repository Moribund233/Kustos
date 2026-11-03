/* Agent run console: runs, steps, approval gate, context */
(function () {
  "use strict";

  const U = window.KustosUtil;
  const runs = window.KUSTOS_AGENT_RUNS;
  window.KustosAgentRuns = runs;

  const runsList = document.getElementById("runs-list");
  const main = document.getElementById("agent-main");
  const CONTEXT_SLOTS = ["ctx-run", "ctx-budget", "ctx-tools", "ctx-guardrails", "ctx-memory", "ctx-actions"];

  function contextSlot(id) {
    return document.getElementById(id);
  }

  function clearContext() {
    CONTEXT_SLOTS.forEach((id) => {
      const slot = contextSlot(id);
      if (slot) slot.innerHTML = "";
    });
  }
  let runFilter = "active";
  let currentId = "A-1042";

  const STATUS = {
    queued: { label: "Queued", badge: "is-info", lamp: "is-info", icon: "clock" },
    running: { label: "Running", badge: "is-info", lamp: "is-info is-live", icon: "loader" },
    awaiting: { label: "Awaiting approval", badge: "is-warn", lamp: "is-warn is-live", icon: "clock" },
    succeeded: { label: "Succeeded", badge: "is-good", lamp: "is-good", icon: "check-circle" },
    failed: { label: "Failed", badge: "is-bad", lamp: "is-bad", icon: "x-circle" },
    cancelled: { label: "Cancelled", badge: "is-outline", lamp: "", icon: "x" }
  };

  const ACTIVE = new Set(["queued", "running", "awaiting"]);

  function meta(run) {
    return STATUS[run.status] || STATUS.queued;
  }

  function isActive(run) {
    return ACTIVE.has(run.status);
  }

  function currentRun() {
    return runs.find((run) => run.id === currentId) || null;
  }

  function updateCounts() {
    const active = runs.filter(isActive).length;
    const completed = runs.length - active;
    const awaiting = runs.filter((run) => run.status === "awaiting").length;
    document.getElementById("active-count").textContent = String(active);
    document.getElementById("completed-count").textContent = String(completed);
    // Concurrency limits live in admin config and are not exposed per user;
    // this footer only states what the list actually knows.
    document.getElementById("runs-foot-copy").textContent = awaiting
      ? `${active} active · ${awaiting} awaiting approval`
      : `${active} active · no approvals pending`;
  }

  function visibleRuns() {
    return runs.filter((run) => (runFilter === "active" ? isActive(run) : !isActive(run)));
  }

  function setRunFilter(filter) {
    runFilter = filter;
    U.qsa("[data-run-filter]").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.runFilter === filter);
    });
  }

  function runItemMarkup(run) {
    const state = meta(run);
    return `<button class="run-item${run.id === currentId ? " is-active" : ""}" type="button" data-run-id="${run.id}">
      <span class="run-item-top">
        <span class="lamp ${state.lamp}" aria-hidden="true"></span>
        <span class="run-item-title">${U.escapeHtml(run.title)}</span>
        <span class="run-item-id">${run.id}</span>
      </span>
      <span class="run-item-meta"><span>${U.escapeHtml(run.repo)}</span><span class="dot">·</span><span>${U.escapeHtml(run.branch)}</span><span class="dot">·</span><span>${U.escapeHtml(run.model)}</span></span>
      <span class="run-item-status"><span class="badge ${state.badge}">${state.label}</span><span>${U.escapeHtml(run.duration)}</span></span>
    </button>`;
  }

  /* Runs are banded by what they demand from the reader: decisions first,
     then work in flight, then history. */
  const GROUP_OF = {
    awaiting: { key: "awaiting", label: "Needs your decision" },
    running: { key: "running", label: "In flight" },
    queued: { key: "running", label: "In flight" },
    succeeded: { key: "succeeded", label: "Succeeded" },
    failed: { key: "failed", label: "Failed" },
    cancelled: { key: "cancelled", label: "Cancelled" }
  };

  function runGroupsMarkup(list) {
    const groups = [];
    list.forEach((run) => {
      const meta = GROUP_OF[run.status] || GROUP_OF.queued;
      let bucket = groups.find((group) => group.key === meta.key);
      if (!bucket) {
        bucket = { key: meta.key, label: meta.label, runs: [] };
        groups.push(bucket);
      }
      bucket.runs.push(run);
    });
    return groups
      .map((group) => `<section class="run-group" aria-label="${group.label}">
        <p class="run-group-head">${group.label}<span class="group-count">${group.runs.length}</span></p>
        ${group.runs.map(runItemMarkup).join("")}
      </section>`)
      .join("");
  }

  function renderRuns() {
    const list = visibleRuns();
    if (currentId && !list.some((run) => run.id === currentId)) {
      currentId = list.length ? list[0].id : null;
    }
    runsList.innerHTML = list.length
      ? runGroupsMarkup(list)
      : '<div class="run-empty"><svg class="icon"><use href="#i-agent"></use></svg><strong>No runs in this view</strong><span>Start a read-only agent run to see the tool loop.</span></div>';
    updateCounts();
  }

  function render() {
    renderRuns();
    renderMain();
  }

  function stepMarkup(step) {
    if (step.type === "assistant") {
      return `<div class="step is-assistant">
        <span class="step-mark" aria-hidden="true">${U.icon("agent", "icon-xs")}</span>
        <div class="step-body">
          <div class="step-head"><span class="step-name">Kustos</span><span class="step-meta">assistant</span></div>
          <div class="step-content">${step.content}</div>
        </div>
      </div>`;
    }

    if (step.type === "user") {
      return `<div class="step is-user">
        <span class="avatar avatar-sm is-amber" style="margin-top:1px" aria-hidden="true">LW</span>
        <div class="step-body">
          <div class="step-head"><span class="step-name">You</span><span class="step-meta">guidance</span></div>
          <div class="step-content">${step.content}</div>
        </div>
      </div>`;
    }

    if (step.type === "error") {
      return `<div class="step is-error">
        <span class="step-mark" aria-hidden="true">${U.icon("alert", "icon-xs")}</span>
        <div class="step-body">
          <div class="step-head"><span class="step-name">run failed</span></div>
          <div class="step-content">${step.content}</div>
        </div>
      </div>`;
    }

    return `<div class="step is-tool">
      <span class="step-mark" aria-hidden="true">${U.icon("clock", "icon-xs")}</span>
      <div class="step-body">
        <div class="step-head"><span class="step-name">state</span></div>
        <div class="step-content">${step.content}</div>
      </div>
    </div>`;
  }

  function msOf(step) {
    const match = String(step.meta || "").match(/([\d.]+)\s*(ms|s)\b/);
    if (!match) return 0;
    const value = Number(match[1]);
    return match[2] === "s" ? value * 1000 : value;
  }

  function formatMs(total) {
    if (!total) return "";
    return total >= 1000 ? `${(total / 1000).toFixed(1)} s` : `${Math.round(total)} ms`;
  }

  /* Tool calls are the noise of an agent run; the conversation is the
     signal. Consecutive calls collapse into one trace block that can be
     opened when the reader wants the receipts. */
  function toolGroupMarkup(items) {
    const total = formatMs(items.reduce((sum, item) => sum + msOf(item), 0));
    return `<div class="step is-tools">
      <span class="step-mark" aria-hidden="true">${U.icon("terminal", "icon-xs")}</span>
      <div class="step-body">
        <details class="tool-group" open>
          <summary class="tool-group-head">
            <span class="tool-group-title">${items.length} tool ${items.length === 1 ? "call" : "calls"}</span>
            <span class="tool-group-meta">read-only${total ? ` · ${total}` : ""}</span>
            ${U.icon("chevron-right", "icon-xs tool-group-caret")}
          </summary>
          <div class="tool-group-body">
            ${items.map((item) => `<div class="tool-row">
              <span class="tool-name">${U.escapeHtml(item.name)}</span>
              ${item.detail ? `<span class="tool-detail">${U.escapeHtml(item.detail)}</span>` : ""}
              ${item.meta ? `<span class="tool-time">${U.escapeHtml(item.meta)}</span>` : ""}
            </div>`).join("")}
          </div>
        </details>
      </div>
    </div>`;
  }

  function stepsMarkup(steps) {
    const out = [];
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      out.push(toolGroupMarkup(batch));
      batch = [];
    };
    steps.forEach((step) => {
      if (step.type === "tool") {
        batch.push(step);
      } else {
        flush();
        out.push(stepMarkup(step));
      }
    });
    flush();
    return out.join("");
  }

  function approvalMarkup(run) {
    const approval = run.approval;
    if (!approval || approval.decision) return "";
    const args = approval.args
      .map(([key, value]) => `<div class="approval-arg"><span class="arg-key">${U.escapeHtml(key)}</span><span class="arg-value">${U.escapeHtml(value)}</span></div>`)
      .join("");
    return `<div class="approval-card" aria-label="Write tool approval">
      <div class="approval-head">
        <span class="approval-mark" aria-hidden="true">${U.icon("shield", "icon-xs")}</span>
        <div><strong>Approval required</strong><span>Write tool · the job is paused</span></div>
        <span class="badge is-warn">blocked</span>
      </div>
      <div class="approval-body">
        <div class="approval-tool-line"><span class="approval-tool">${U.icon("terminal", "icon-xs")}${U.escapeHtml(approval.tool)}</span></div>
        <div class="approval-args">${args}</div>
        <div class="approval-context">
          <p class="approval-reason">${U.escapeHtml(approval.reason)}</p>
          <p class="approval-note">${U.escapeHtml(approval.note)}</p>
        </div>
      </div>
      <div class="approval-actions">
        <button class="btn btn-primary btn-sm" type="button" data-approve>${U.icon("check")}Approve</button>
        <button class="btn btn-ghost btn-sm" type="button" data-reject>${U.icon("x")}Reject</button>
        <span class="fine">No write happens without this decision.</span>
      </div>
    </div>`;
  }

  function composerMarkup(run) {
    if (run.status === "awaiting") {
      return `<div class="composer-lock"><span class="lamp is-warn is-live" aria-hidden="true"></span><span>The run is paused at the approval gate. Approve or reject the write tool above to continue.</span></div>`;
    }
    return `<form class="run-composer" data-run-composer>
      <span class="avatar avatar-sm is-amber" aria-hidden="true">LW</span>
      <div class="composer-box">
        <textarea id="run-composer-input" rows="2" placeholder="Ask a follow-up or add guidance…" aria-label="Follow up with the agent"></textarea>
        <div class="composer-foot">
          <span class="composer-hint">Read-only follow-up · no new write tools</span>
          <button class="btn btn-primary btn-sm" type="submit">${U.icon("send")}Send</button>
        </div>
      </div>
    </form>`;
  }

  function renderMain() {
    const run = currentRun();
    if (!run) {
      main.innerHTML = `<div class="run-empty">${U.icon("agent")}<strong>No run selected</strong><span>Pick a run from the list or start a new one.</span></div>`;
      clearContext();
      return;
    }

    const state = meta(run);
    const pending = run.approval && !run.approval.decision;
    const promptAvatar = run.startedBy.startsWith("Trigger")
      ? `<span class="avatar avatar-sm is-bot" aria-hidden="true">${U.icon("agent", "icon-xs")}</span>`
      : '<span class="avatar avatar-sm is-amber" aria-hidden="true">LW</span>';

    main.innerHTML = `<header class="run-head">
      <div class="run-head-main">
        <div class="run-kicker">
          <span class="badge ${state.badge}"><span class="lamp ${state.lamp}" aria-hidden="true"></span>${state.label}</span>
          <span class="mono muted">${run.id}</span>
        </div>
        <h2 class="display-sm">${U.escapeHtml(run.title)}</h2>
        <p class="run-head-meta">${U.escapeHtml(run.repo)} <span class="dot">·</span> ${U.escapeHtml(run.branch)} <span class="dot">·</span> ${U.escapeHtml(run.model)} <span class="dot">·</span> ${run.stepCount} steps <span class="dot">·</span> ${U.escapeHtml(run.duration)}</p>
      </div>
      <div class="run-actions">
        ${isActive(run) ? `<button class="btn btn-ghost btn-sm" type="button" data-cancel-run>${U.icon("x")}Cancel</button>` : ""}
        ${run.status === "failed" ? `<button class="btn btn-ghost btn-sm" type="button" data-retry-run>${U.icon("refresh")}Retry</button>` : ""}
        <button class="icon-btn is-bordered" type="button" aria-label="More run actions" data-toast="Run exports and step JSON belong to the agent controller.">${U.icon("more")}</button>
      </div>
    </header>
    <div class="run-scroll">
      <div class="prompt-block">
        ${promptAvatar}
        <div>
          <div class="prompt-head"><span class="prompt-author">${U.escapeHtml(run.startedBy)}</span><span class="prompt-time">${U.escapeHtml(run.created)}</span></div>
          <p class="prompt-body">${U.escapeHtml(run.prompt)}</p>
        </div>
      </div>
      <div class="steps">${stepsMarkup(run.steps)}</div>
    </div>
    ${approvalMarkup(run)}
    ${composerMarkup(run)}`;

    bindRunActions(run);
    renderContext(run);
    updateBreadcrumb(run);
    document.body.dataset.crumb = `Agent|Run ${run.id}`;
    document.title = `Agent ${run.id} · Kustos`;

    const scroller = main.querySelector(".run-scroll");
    if (scroller && run.status === "awaiting") {
      window.requestAnimationFrame(() => {
        scroller.scrollTop = scroller.scrollHeight;
      });
    }
  }

  function renderContext(run) {
    const state = meta(run);
    const promptTokens = run.promptTokens || 0;
    const completionTokens = run.completionTokens || 0;
    const cachedTokens = run.cachedTokens || 0;
    const totalTokens = Math.max(run.tokensUsed || 0, promptTokens + completionTokens);
    const share = (value) => (totalTokens ? Math.round((value / totalTokens) * 100) : 0);
    const writeEnabled = run.writeEnabled !== false;
    // Cached tokens are a subset of prompt tokens; do not stack all three.
    const promptOnly = Math.max(0, promptTokens - cachedTokens);
    const prompt = `Audit run ${run.id} (${run.title}) and tell me whether any write tool can execute before an explicit approval.`;

    // The panel header follows the selected run.
    U.qsa("[data-panel-tab]", document.getElementById("agent-stage")).forEach((tab) => {
      tab.dataset.panelKicker = `Agent · ${run.id}`;
    });
    const kicker = document.querySelector(".float-panel .float-head .eyebrow");
    if (kicker) kicker.textContent = `Agent · ${run.id}`;

    contextSlot("ctx-run").innerHTML = `<h3>Run</h3>
      <dl class="context-list">
        <div><dt>Status</dt><dd><span class="badge ${state.badge}">${state.label}</span></dd></div>
        <div><dt>Origin</dt><dd>${run.origin === "trigger" ? '<span class="badge is-outline">trigger · read-only</span>' : '<span class="badge is-outline">user</span>'}</dd></div>
        <div><dt>Repository</dt><dd>${U.escapeHtml(run.repo)}</dd></div>
        <div><dt>Branch</dt><dd class="mono">${U.escapeHtml(run.branch)}</dd></div>
        <div><dt>Model</dt><dd>${U.escapeHtml(run.model)}</dd></div>
        <div><dt>Started by</dt><dd>${U.escapeHtml(run.startedBy)}</dd></div>
        <div><dt>Session</dt><dd>${U.escapeHtml(run.session)}</dd></div>
        <div><dt>Created</dt><dd>${U.escapeHtml(run.created)}</dd></div>
      </dl>`;

    contextSlot("ctx-budget").innerHTML = `<h3>Token usage</h3>
      <div class="budget-line"><span>Job total</span><strong>${(totalTokens / 1000).toFixed(1)}k</strong></div>
      <div class="token-bar" aria-hidden="true">
        <span class="is-prompt" style="width:${share(promptOnly)}%"></span>
        <span class="is-cached" style="width:${share(cachedTokens)}%"></span>
        <span class="is-completion" style="width:${share(completionTokens)}%"></span>
      </div>
      <dl class="kv compact">
        <div class="kv-row"><dt class="kv-key">Prompt</dt><dd class="kv-val is-mono">${(promptTokens / 1000).toFixed(1)}k</dd></div>
        <div class="kv-row"><dt class="kv-key">Completion</dt><dd class="kv-val is-mono">${(completionTokens / 1000).toFixed(1)}k</dd></div>
        <div class="kv-row"><dt class="kv-key">Cached (in prompt)</dt><dd class="kv-val is-mono">${(cachedTokens / 1000).toFixed(1)}k</dd></div>
      </dl>
      <div class="budget-foot"><span>${run.stepCount} steps</span><span>provider usage</span></div>
      <p class="context-note">Per-job usage only. Daily and per-user quotas are enforced server-side; the limits are not exposed to this view.</p>`;

    contextSlot("ctx-tools").innerHTML = `<h3>Tools allowed</h3>
      <div class="tool-chips">
        <span class="tool-chip">${U.icon("search", "icon-xs")}search_code</span>
        <span class="tool-chip">${U.icon("file", "icon-xs")}read_file</span>
        <span class="tool-chip">${U.icon("diff", "icon-xs")}get_diff</span>
        <span class="tool-chip">${U.icon("code", "icon-xs")}find_usages</span>
        <span class="tool-chip">${U.icon("history", "icon-xs")}list_commits</span>
      </div>
      ${writeEnabled ? `<div class="tool-chips is-write-row">
        <span class="tool-chip is-write">${U.icon("shield", "icon-xs")}create_issue</span>
        <span class="tool-chip is-write">${U.icon("shield", "icon-xs")}comment_on_issue</span>
        <span class="tool-chip is-write">${U.icon("shield", "icon-xs")}commit_file</span>
      </div>
      <p class="context-note">Each write pauses for an explicit decision.</p>` : `<p class="context-note is-readonly">Trigger-origin run — read tools only. The tool registry never attaches a write tool, so no approval can appear.</p>`}`;

    contextSlot("ctx-guardrails").innerHTML = `<h3>Guardrails</h3>
      <div class="guardrail-list">
        <div class="guardrail">${U.icon("shield")}Write tools require an explicit decision.</div>
        <div class="guardrail">${U.icon("check")}Acting as Lin Wei — global admin, repo owner.</div>
        <div class="guardrail is-warn">${U.icon("alert")}Trigger-origin runs are read-only.</div>
        <div class="guardrail">${U.icon("check")}Tool results are capped before context injection.</div>
      </div>`;

    contextSlot("ctx-memory").innerHTML = `<h3>Session memory</h3>
      <p class="memory">${U.escapeHtml(run.memory)}</p>`;

    contextSlot("ctx-actions").innerHTML = `<h3>Actions</h3>
      <div class="context-actions">
        <button class="btn btn-quiet btn-sm" type="button" data-copy="${run.id}" data-copy-label="Run ID copied">${U.icon("copy")}Copy run ID</button>
        <a class="btn btn-quiet btn-sm" href="chat.html">${U.icon("chat")}Open in chat</a>
        <button class="btn btn-quiet btn-sm" type="button" data-open-run data-prompt="${U.escapeHtml(prompt)}">${U.icon("agent")}Ask a follow-up</button>
      </div>`;
  }

  function updateBreadcrumb(run) {
    const crumbs = document.getElementById("crumbs");
    if (!crumbs) return;
    crumbs.innerHTML = `<span>Agent</span><span class="sep" aria-hidden="true">/</span><span class="current" aria-current="page">Run ${run.id}</span>`;
  }

  function bindRunActions(run) {
    const approve = main.querySelector("[data-approve]");
    if (approve) approve.addEventListener("click", () => approveRun(run));

    const reject = main.querySelector("[data-reject]");
    if (reject) reject.addEventListener("click", () => rejectRun(run));

    const cancel = main.querySelector("[data-cancel-run]");
    if (cancel) {
      cancel.addEventListener("click", () => {
        run.status = "cancelled";
        run.steps.push({ type: "note", content: "Cancelled by Lin Wei. The worker will stop at the next checkpoint." });
        run.stepCount = run.steps.length;
        setRunFilter("completed");
        render();
        window.Kustos.toast(`Run ${run.id} cancelled.`, { tone: "warn", title: "Run stopped" });
      });
    }

    const retry = main.querySelector("[data-retry-run]");
    if (retry) {
      retry.addEventListener("click", () => {
        run.status = "queued";
        run.steps = [{ type: "note", content: "Retry queued by Lin Wei. Waiting for a worker." }];
        run.stepCount = 1;
        setRunFilter("active");
        render();
        window.Kustos.toast(`Run ${run.id} re-queued.`, { tone: "good", title: "Retry queued" });
        window.setTimeout(() => {
          if (run.status !== "queued") return;
          run.status = "running";
          run.steps.push({ type: "tool", name: "get_build_logs", detail: "atlas-e2e · retry 1", meta: "41 ms" });
          run.stepCount = run.steps.length;
          if (currentId === run.id) render();
          else renderRuns();
        }, 1200);
      });
    }

    const form = main.querySelector("[data-run-composer]");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const input = document.getElementById("run-composer-input");
        const text = input.value.trim();
        if (!text) {
          input.focus();
          return;
        }
        run.steps.push({
          type: "user",
          content: U.escapeHtml(text).replace(/\n/g, "<br>")
        });
        run.stepCount = run.steps.length;
        run.tokensUsed += 180;
        renderMain();
        window.setTimeout(() => {
          if (currentId !== run.id) return;
          run.steps.push({
            type: "assistant",
            content: "Noted. I will fold that into the next step and keep the same read-only boundary."
          });
          run.stepCount = run.steps.length;
          renderMain();
          window.Kustos.toast("Follow-up added to the run.", { tone: "good" });
        }, 850);
      });
    }
  }

  function approveRun(run) {
    if (!run.approval || run.approval.decision) return;
    run.approval.decision = "approved";
    run.status = "succeeded";
    run.steps.push({
      type: "tool",
      name: "create_issue",
      detail: "#95 · LFS download accepts upload-scoped transfer tokens",
      meta: "written · 1.2 s"
    });
    run.steps.push({
      type: "assistant",
      content: "Issue <a href=\"issues.html\">#95</a> opened with the repro and the failing test path. The review thread on PR #142 can stay open until the fix lands."
    });
    run.stepCount = run.steps.length;
    run.duration = "2m 31s";
    run.tokensUsed += 2100;
    setRunFilter("completed");
    render();
    window.Kustos.toast("Issue #95 opened by Kustos.", { tone: "good", title: "Approval recorded" });
  }

  function rejectRun(run) {
    if (!run.approval || run.approval.decision) return;
    run.approval.decision = "rejected";
    run.status = "succeeded";
    run.steps.push({
      type: "assistant",
      content: "Understood — I will not open the issue. The finding stays in the PR review, and I made no write to the tracker."
    });
    run.stepCount = run.steps.length;
    run.duration = "2m 18s";
    setRunFilter("completed");
    render();
    window.Kustos.toast("Write tool rejected. The run finished without writing.", { tone: "warn", title: "Rejected" });
  }

  function createRun(detail) {
    const maxId = runs.reduce((max, run) => {
      const n = Number(run.id.replace("A-", ""));
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 1000);
    const id = `A-${maxId + 1}`;
    const prompt = detail.prompt || "New agent run";
    const firstLine = prompt.split(/[.!?\n]/)[0].trim();
    const run = {
      id,
      title: firstLine.length > 64 ? `${firstLine.slice(0, 61)}…` : firstLine || "New agent run",
      repo: detail.repo || "lin/atlas",
      branch: "main",
      status: "queued",
      model: detail.model || "default",
      session: "New run",
      created: "just now",
      startedBy: "Lin Wei",
      duration: "—",
      tokensUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      origin: "user",
      writeEnabled: detail.allowWrite !== false,
      stepCount: 1,
      prompt,
      memory: "New session. No prior context has been folded in.",
      steps: [{ type: "note", content: "Queued by Lin Wei. Waiting for a worker to claim the job." }],
      approval: null
    };
    runs.unshift(run);
    currentId = id;
    setRunFilter("active");
    render();
    window.Kustos.toast(`Run ${id} queued for ${run.repo}.`, { tone: "good", title: "Agent run queued" });

    window.setTimeout(() => {
      if (run.status !== "queued") return;
      run.status = "running";
      run.steps.push({ type: "tool", name: "search_code", detail: `query: ${run.title}`, meta: "index · 120 ms" });
      run.stepCount = run.steps.length;
      if (currentId === run.id) renderMain();
      else renderRuns();
    }, 1100);

    window.setTimeout(() => {
      if (run.status !== "running") return;
      run.steps.push({
        type: "assistant",
        content: "I am reading the relevant files now. The run will pause before any write."
      });
      run.stepCount = run.steps.length;
      run.tokensUsed += 640;
      if (currentId === run.id) renderMain();
      else renderRuns();
    }, 2200);
  }

  /* Events ----------------------------------------------------------- */
  runsList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-run-id]");
    if (!item) return;
    currentId = item.dataset.runId;
    render();
    const scroller = main.querySelector(".run-scroll");
    if (scroller) scroller.scrollTop = 0;
  });

  U.qsa("[data-run-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      setRunFilter(button.dataset.runFilter);
      render();
    });
  });

  window.addEventListener("kustos:start-run", (event) => {
    createRun(event.detail || { prompt: "New agent run" });
  });

  /* Load a run queued from another page ----------------------------- */
  try {
    const stored = sessionStorage.getItem("kustos:new-run");
    if (stored) {
      sessionStorage.removeItem("kustos:new-run");
      createRun(JSON.parse(stored));
    } else {
      render();
    }
  } catch (error) {
    render();
  }

  console.assert(runs.length >= 5, "Agent: demo runs loaded");
  console.assert(
    runs.filter(isActive).length >= 2,
    "Agent: at least two active runs"
  );
})();
