/* Issues list, detail and new-issue flow */
(function () {
  "use strict";

  const U = window.KustosUtil;
  const ISSUES = window.KUSTOS_ISSUES;
  const rows = document.getElementById("issue-rows");
  const detail = document.getElementById("issue-detail");
  const listFoot = document.getElementById("issue-list-foot");
  const search = document.getElementById("issue-search");
  const newIssueForm = document.getElementById("new-issue-form");

  let statusFilter = "open";
  let activeLabel = "";
  let query = "";
  let currentId = 94;

  const LIN = { name: "Lin Wei", initials: "LW", color: "amber" };

  function countBy(status) {
    return ISSUES.filter((issue) => issue.status === status).length;
  }

  function labelMarkup(labels) {
    return labels.map((label) => `<span class="issue-label is-${U.escapeHtml(label)}">${U.escapeHtml(label)}</span>`).join("");
  }

  function priorityClass(priority) {
    if (priority === "high") return "is-bad";
    if (priority === "medium") return "is-warn";
    return "is-outline";
  }

  function avatarMarkup(person, size) {
    if (!person) return `<span class="avatar ${size || "avatar-sm"} is-slate" aria-hidden="true">—</span>`;
    return `<span class="avatar ${size || "avatar-sm"} is-${U.escapeHtml(person.color)}" aria-hidden="true">${U.escapeHtml(person.initials)}</span>`;
  }

  function updateCounts() {
    const open = countBy("open");
    const closed = countBy("closed");
    const assigned = ISSUES.filter((issue) => issue.status === "open" && issue.assignee && issue.assignee.name === "Lin Wei").length;
    document.getElementById("open-count").textContent = String(open);
    document.getElementById("closed-count").textContent = String(closed);
    document.getElementById("assigned-count").textContent = String(assigned);
    document.getElementById("open-filter-count").textContent = String(open);
    const closedFilter = document.getElementById("closed-filter-count");
    if (closedFilter) closedFilter.textContent = String(closed);
  }

  function filteredIssues() {
    const q = query.trim().toLowerCase();
    return ISSUES.filter((issue) => {
      if (issue.status !== statusFilter) return false;
      if (activeLabel && !issue.labels.includes(activeLabel)) return false;
      if (!q) return true;
      return `${issue.id} ${issue.title} ${issue.labels.join(" ")} ${issue.author.name}`.toLowerCase().includes(q);
    });
  }

  function rowMarkup(issue) {
    const active = issue.id === currentId;
    const assignee = issue.assignee;
    return `<button class="issue-row${active ? " is-active" : ""}" type="button" data-issue-id="${issue.id}">
      <span class="issue-status-icon${issue.status === "closed" ? " is-closed" : ""}" aria-hidden="true"></span>
      <span class="issue-row-copy">
        <span class="issue-row-title">${U.escapeHtml(issue.title)}</span>
        <span class="issue-row-meta"><span>#${issue.id}</span><span class="dot">·</span><span>${U.escapeHtml(issue.opened)}</span><span class="dot">·</span><span>${issue.comments.length} comments</span></span>
        <span class="issue-row-labels">${labelMarkup(issue.labels)}</span>
      </span>
      <span class="issue-row-side">
        ${avatarMarkup(assignee, "avatar-sm")}
      </span>
    </button>`;
  }

  const PRIORITY_GROUPS = [
    { key: "high", label: "High priority" },
    { key: "medium", label: "Medium priority" },
    { key: "low", label: "Low priority" }
  ];

  /* The list is triaged into priority bands. A flat run of twelve rows was
     the least useful shape for "what do I open first". */
  function groupMarkup(list) {
    return PRIORITY_GROUPS.map((group) => {
      const items = list.filter((issue) => issue.priority === group.key);
      if (!items.length) return "";
      return `<section class="issue-group" aria-label="${group.label}">
        <div class="issue-group-head">
          <span class="issue-group-key">${group.label}</span>
          <span class="group-count">${items.length}</span>
          <span class="issue-group-rule" aria-hidden="true"></span>
        </div>
        ${items.map(rowMarkup).join("")}
      </section>`;
    }).join("");
  }

  function renderList() {
    const list = filteredIssues();
    if (currentId !== null && !list.some((issue) => issue.id === currentId)) {
      currentId = list.length ? list[0].id : null;
    }
    rows.innerHTML = list.length
      ? groupMarkup(list)
      : '<div class="issue-empty">No issues match this filter.</div>';
    listFoot.innerHTML = `<span class="lamp ${list.length ? "is-good" : "is-warn"}" aria-hidden="true"></span>
      <span>Showing ${list.length} of ${ISSUES.length} issues</span>
      <span class="spacer"></span>
      <span>Recently updated</span>`;
  }

  function triageMarkup(issue) {
    const prompt = `Draft a minimal fix for issue #${issue.id}: ${issue.title}. Read the linked files first and tell me the smallest safe change.`;
    return `<section class="triage-card" aria-label="Kustos triage">
      <div class="triage-meta">
        <span class="badge is-warn">read-only</span>
        <span class="fine">derived from this issue, not stored separately</span>
      </div>
      <p class="triage-body">${issue.triage.summary}</p>
      <p class="triage-next">Next: ${issue.triage.next}</p>
      <div class="triage-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-open-run data-prompt="${U.escapeHtml(prompt)}">${U.icon("agent")}Draft a fix</button>
        <button class="btn btn-quiet btn-sm" type="button" data-toast="Triage is a read-only agent summary attached to this issue; it proposes no writes.">How this was derived</button>
      </div>
    </section>`;
  }

  function commentMarkup(comment) {
    const person = comment.author;
    const avatar = person.color === "bot"
      ? `<span class="avatar avatar-sm is-bot" aria-hidden="true">${U.icon("agent", "icon-xs")}</span>`
      : avatarMarkup(person, "avatar-sm");
    return `<div class="issue-comment">
      ${avatar}
      <div>
        <div class="comment-head"><strong>${U.escapeHtml(person.name)}</strong><time>${U.escapeHtml(comment.time)}</time>${person.color === "bot" ? '<span class="badge is-warn">agent</span>' : ""}</div>
        <div class="comment-copy"><p>${comment.body}</p></div>
      </div>
    </div>`;
  }

  function detailMarkup(issue) {
    if (!issue) {
      return `<div class="issue-detail-inner"><div class="empty">${U.icon("issue")}<strong>No issue selected</strong><span>Choose an issue or clear the filters.</span></div></div>`;
    }

    const closed = issue.status === "closed";
    const body = issue.body.map((paragraph) => `<p>${paragraph}</p>`).join("");
    const code = issue.code
      ? `<div class="issue-code"><div class="issue-code-label mono">${U.escapeHtml(issue.code.label)}</div><pre>${issue.code.lines.map((line) => U.escapeHtml(line)).join("\n")}</pre></div>`
      : "";

    const comments = issue.comments.length
      ? issue.comments.map(commentMarkup).join("")
      : '<div class="issue-empty">No comments yet. Start the thread.</div>';

    return `<div class="issue-detail-inner">
      <header class="issue-detail-head">
        <div>
          <div class="issue-detail-kicker">
            <span class="badge ${closed ? "is-outline" : "is-good"}">${closed ? "Closed" : "Open"}</span>
            <span class="mono muted">#${issue.id}</span>
            <span class="badge ${priorityClass(issue.priority)}">${U.escapeHtml(issue.priority)}</span>
          </div>
          <h2 class="display-sm">${U.escapeHtml(issue.title)}</h2>
          <p class="issue-detail-meta">
            opened ${U.escapeHtml(issue.opened)} by ${U.escapeHtml(issue.author.name)}
            <span class="dot">·</span> ${issue.comments.length} comments
            <span class="dot">·</span> updated ${U.escapeHtml(issue.updated)}
          </p>
        </div>
        <div class="issue-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-toggle-status>${closed ? "Reopen issue" : "Close issue"}</button>
          <button class="icon-btn is-bordered" type="button" aria-label="More issue actions" data-toast="More issue actions belong to the issue controller.">${U.icon("more")}</button>
        </div>
      </header>

      <div class="issue-detail-main">
          <div class="issue-body">${body}</div>
          ${code}

          <section class="issue-activity" id="issue-activity" aria-label="Activity">
            <div class="activity-head"><h3>Activity</h3><span class="section-meta">${issue.comments.length} comments</span></div>
            ${comments}
            <form class="comment-form" data-comment-form>
              <span class="avatar avatar-sm is-amber" aria-hidden="true">LW</span>
              <div class="comment-box">
                <textarea id="issue-comment-input" rows="3" placeholder="Add a comment…" aria-label="Add a comment"></textarea>
                <div class="comment-foot">
                  <span class="fine">Markdown supported · notifications follow your preferences</span>
                  <button class="btn btn-primary btn-sm" type="submit">Comment</button>
                </div>
              </div>
            </form>
          </section>
        </div>

      </div>
    </div>`;
  }

  function metaMarkup(issue) {
    const assignee = issue.assignee
      ? `<div class="meta-value">${avatarMarkup(issue.assignee, "avatar-sm")}${U.escapeHtml(issue.assignee.name)}</div>`
      : '<div class="meta-value is-muted">Unassigned</div>';

    const linkedPrs = (issue.pullRequests || []).length
      ? issue.pullRequests
          .map(
            (pr) => `<a class="meta-link" href="pull.html">#${pr.number} · ${U.escapeHtml(pr.title)}<span class="fine">${pr.status}${pr.closesOnMerge ? " · closes on merge" : ""}</span></a>`
          )
          .join("")
      : '<div class="meta-value is-muted">None</div>';

    return `<h3>Fields</h3>
      <div class="meta-group"><span>Assignee</span>${assignee}</div>
      <div class="meta-group"><span>Labels</span><div class="meta-labels">${labelMarkup(issue.labels)}</div></div>
      <div class="meta-group"><span>Priority</span><div class="meta-value"><span class="badge ${priorityClass(issue.priority)}">${U.escapeHtml(issue.priority)}</span></div></div>
      <div class="meta-group"><span>Linked pull request</span>${linkedPrs}</div>
      <div class="meta-group"><span>Opened by</span><div class="meta-value">${avatarMarkup(issue.author, "avatar-sm")}${U.escapeHtml(issue.author.name)}</div></div>
      ${issue.closedBy ? `<div class="meta-group"><span>Closed by</span><div class="meta-value is-muted">${U.escapeHtml(issue.closedBy)}</div></div>` : ""}`;
  }

  function renderDetail() {
    const issue = ISSUES.find((item) => item.id === currentId);
    detail.innerHTML = detailMarkup(issue);

    const metaSlot = document.getElementById("issue-panel-meta");
    const triageSlot = document.getElementById("issue-panel-triage");
    const kicker = document.getElementById("issue-panel-kicker");
    if (metaSlot) metaSlot.innerHTML = issue ? metaMarkup(issue) : '<p class="context-note">No issue selected.</p>';
    if (triageSlot) triageSlot.innerHTML = issue ? triageMarkup(issue) : '<p class="context-note">No issue selected.</p>';
    const kickerText = issue ? `#${issue.id} · lin/atlas` : "Issue";
    if (kicker) kicker.textContent = kickerText;
    U.qsa("[data-panel-tab]", document.getElementById("issue-stage")).forEach((tab) => {
      tab.dataset.panelKicker = kickerText;
    });

    if (!issue) return;

    const toggle = detail.querySelector("[data-toggle-status]");
    toggle.addEventListener("click", () => {
      issue.status = issue.status === "open" ? "closed" : "open";
      issue.closedBy = issue.status === "closed" ? "Lin Wei" : undefined;
      issue.updated = "just now";
      window.Kustos.toast(
        issue.status === "closed" ? `Issue #${issue.id} closed.` : `Issue #${issue.id} reopened.`,
        { tone: "good", title: issue.status === "closed" ? "Issue closed" : "Issue reopened" }
      );
      render();
    });

    const commentForm = detail.querySelector("[data-comment-form]");
    commentForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("issue-comment-input");
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      issue.comments.push({
        author: LIN,
        time: "just now",
        body: U.escapeHtml(text).replace(/\n/g, "<br>")
      });
      issue.updated = "just now";
      render();
      const activity = document.getElementById("issue-activity");
      if (activity) activity.scrollIntoView({ block: "nearest", behavior: "smooth" });
      window.Kustos.toast("Comment added.", { tone: "good" });
    });
  }

  function render() {
    updateCounts();
    renderList();
    renderDetail();
  }

  rows.addEventListener("click", (event) => {
    const row = event.target.closest("[data-issue-id]");
    if (!row) return;
    currentId = Number(row.dataset.issueId);
    renderList();
    renderDetail();
    detail.scrollTop = 0;
  });

  U.qsa("[data-status-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      statusFilter = button.dataset.statusFilter;
      U.qsa("[data-status-filter]").forEach((node) => node.classList.toggle("is-active", node === button));
      render();
    });
  });

  U.qsa("[data-label-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      activeLabel = button.dataset.labelFilter;
      U.qsa("[data-label-filter]").forEach((node) => node.classList.toggle("is-active", node === button));
      render();
    });
  });

  search.addEventListener("input", () => {
    query = search.value;
    render();
  });

  /* New issue -------------------------------------------------------- */
  const newIssueModal = document.getElementById("new-issue-modal");

  function openNewIssue() {
    window.Kustos.openModal("new-issue-modal");
  }

  document.getElementById("new-issue-btn").addEventListener("click", openNewIssue);

  newIssueForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = document.getElementById("new-issue-name").value.trim();
    if (!title) {
      document.getElementById("new-issue-name").focus();
      return;
    }
    const description = document.getElementById("new-issue-body").value.trim();
    const labels = U.qsa('input[name="labels"]:checked').map((input) => input.value);
    const priority = document.getElementById("new-issue-priority").value.toLowerCase();
    const assigneeName = document.getElementById("new-issue-assignee").value;
    const people = {
      "Lin Wei (you)": LIN,
      "Mara Voss": { name: "Mara Voss", initials: "MV", color: "rose" },
      "Ilya Sokolov": { name: "Ilya Sokolov", initials: "IS", color: "sky" },
      "Noor Haddad": { name: "Noor Haddad", initials: "NH", color: "rose" }
    };
    const issue = {
      id: Math.max(...ISSUES.map((item) => item.id)) + 1,
      title,
      status: "open",
      priority,
      labels,
      author: LIN,
      assignee: people[assigneeName] || null,
      opened: "just now",
      updated: "just now",
      pullRequests: [],
      body: description
        ? description.split(/\n{2,}/).map((part) => U.escapeHtml(part).replace(/\n/g, "<br>"))
        : ["No description yet."],
      triage: {
        summary: "New issue. Kustos has not triaged this thread yet.",
        next: "Ask for a read-only triage before assigning a fix."
      },
      comments: []
    };

    ISSUES.unshift(issue);
    currentId = issue.id;
    statusFilter = "open";
    activeLabel = "";
    query = "";
    search.value = "";
    U.qsa("[data-status-filter]").forEach((node) => node.classList.toggle("is-active", node.dataset.statusFilter === "open"));
    U.qsa("[data-label-filter]").forEach((node) => node.classList.toggle("is-active", node.dataset.labelFilter === ""));
    render();
    window.Kustos.closeModal("new-issue-modal");
    newIssueForm.reset();
    window.Kustos.toast(`Issue #${issue.id} created.`, { tone: "good", title: "Issue opened" });
  });

  if (new URLSearchParams(window.location.search).get("new") === "1") {
    openNewIssue();
  }

  render();

  console.assert(ISSUES.length === 12, "Issues: twelve demo issues");
  console.assert(
    U.qsa("[data-status-filter]").length === 2,
    "Issues: status filters are present"
  );
})();
