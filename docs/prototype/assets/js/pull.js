/* Pull request review and merge flow */
(function () {
  "use strict";

  const U = window.KustosUtil;
  const state = { approved: false, e2ePassed: false, changesRequested: false, merged: false };
  const tabs = U.qsa("[data-pr-tab]");
  const panels = U.qsa("[data-pr-panel]");
  const prState = document.getElementById("pr-state");
  const yourReview = document.getElementById("your-review");
  const approveBtn = document.getElementById("approve-btn");
  const requestBtn = document.getElementById("request-btn");
  const mergeBtn = document.getElementById("merge-btn");
  const mergeBox = document.getElementById("merge-box");
  const mergeTitle = document.getElementById("merge-title");
  const mergeDesc = document.getElementById("merge-desc");
  const mergeLamp = document.getElementById("merge-lamp");
  const mergeReviewState = document.getElementById("merge-review-state");
  const mergeCheckState = document.getElementById("merge-check-state");
  const timeline = document.getElementById("pr-timeline");

  function setTab(name) {
    tabs.forEach((tab) => {
      const active = tab.dataset.prTab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.prPanel !== name;
    });
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => setTab(tab.dataset.prTab));
  });

  /* Diffs ------------------------------------------------------------ */
  U.qsa("[data-diff-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const file = button.closest("[data-diff-file]");
      const body = file.querySelector(".diff-body");
      const open = file.classList.toggle("is-open");
      body.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      button.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${file.querySelector(".diff-path").textContent}`);
    });
  });

  function revealLine(line) {
    setTab("files");
    const firstFile = document.querySelector("[data-diff-file]");
    if (firstFile && !firstFile.classList.contains("is-open")) {
      firstFile.classList.add("is-open");
      firstFile.querySelector(".diff-body").hidden = false;
    }
    const target = document.querySelector(`[data-diff-line="${line}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("is-flash");
    window.setTimeout(() => target.classList.remove("is-flash"), 1700);
  }

  U.qsa("[data-view-line]").forEach((button) => {
    button.addEventListener("click", () => revealLine(button.dataset.viewLine));
  });

  document.getElementById("resolve-thread").addEventListener("click", (event) => {
    const thread = document.getElementById("diff-thread");
    thread.classList.add("is-resolved");
    event.currentTarget.textContent = "Resolved";
    event.currentTarget.disabled = true;
    window.Kustos.toast("Review thread resolved.", { tone: "good" });
  });

  /* Merge state ------------------------------------------------------ */
  function setMergeCheck(node, good, label) {
    node.innerHTML = `${U.icon(good ? "check" : "clock", "icon-xs")}${U.escapeHtml(label)}`;
    node.style.color = good ? "var(--sage)" : "";
  }

  function updateMergeState() {
    if (state.merged) return;

    mergeBox.classList.toggle("is-ready", state.approved && state.e2ePassed && !state.changesRequested);

    if (state.changesRequested) {
      mergeTitle.textContent = "Changes requested";
      mergeDesc.textContent = "Resolve the blocking finding before merge.";
      mergeLamp.innerHTML = '<span class="lamp is-bad"></span>';
      mergeBtn.disabled = true;
      setMergeCheck(mergeReviewState, false, "Changes requested");
      setMergeCheck(mergeCheckState, state.e2ePassed, state.e2ePassed ? "e2e passed" : "e2e queued");
      return;
    }

    if (!state.approved) {
      mergeTitle.textContent = "Review required";
      mergeDesc.textContent = state.e2ePassed ? "1 approval remains." : "1 approval and 1 check remaining.";
      mergeLamp.innerHTML = '<span class="lamp is-warn"></span>';
      mergeBtn.disabled = true;
      setMergeCheck(mergeReviewState, false, "Review required");
      setMergeCheck(mergeCheckState, state.e2ePassed, state.e2ePassed ? "e2e passed" : "e2e queued");
      return;
    }

    if (!state.e2ePassed) {
      mergeTitle.textContent = "Waiting on e2e";
      mergeDesc.textContent = "Review approved. One required check is still running.";
      mergeLamp.innerHTML = '<span class="lamp is-warn is-live"></span>';
      mergeBtn.disabled = true;
      setMergeCheck(mergeReviewState, true, "Approved");
      setMergeCheck(mergeCheckState, false, "e2e running");
      return;
    }

    mergeTitle.textContent = "Ready to merge";
    mergeDesc.textContent = "All required reviews and checks are satisfied.";
    mergeLamp.innerHTML = '<span class="lamp is-good"></span>';
    mergeBtn.disabled = false;
    setMergeCheck(mergeReviewState, true, "Approved");
    setMergeCheck(mergeCheckState, true, "e2e passed");
  }

  function markE2EPassed() {
    state.e2ePassed = true;
    const row = document.querySelector('[data-check="e2e"]');
    if (row) {
      row.querySelector(".check-icon").className = "check-icon is-good";
      row.querySelector(".check-icon").innerHTML = U.icon("check", "icon-sm");
      row.querySelector("div > span").textContent = "playwright · 42 passed · 2m 08s";
      const badge = row.querySelector("[data-e2e-badge]");
      badge.className = "badge is-good";
      badge.textContent = "passed";
      row.querySelector(":scope > .mono").textContent = "2m 08s";
    }
    const mini = document.querySelector("[data-mini-e2e]");
    if (mini) {
      mini.querySelector(".lamp").className = "lamp is-good";
      mini.querySelector(".mini-check-time").textContent = "2m 08s";
    }
    updateMergeState();
    window.Kustos.toast("e2e passed — 42 tests, 2m 08s.", { tone: "good", title: "Check passed" });
  }

  function appendTimeline(initials, color, title, detail) {
    const item = document.createElement("li");
    item.className = "timeline-item";
    item.innerHTML = `
      <span class="timeline-avatar avatar is-${color}" aria-hidden="true">${initials}</span>
      <div class="timeline-copy">
        <div class="timeline-head"><strong>Lin Wei</strong><span>${U.escapeHtml(title)}</span></div>
        ${detail ? `<div class="comment-body"><p>${U.escapeHtml(detail)}</p></div>` : ""}
      </div>
    `;
    timeline.appendChild(item);
    item.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  approveBtn.addEventListener("click", () => {
    if (state.approved || state.merged || state.changesRequested) return;
    state.approved = true;
    yourReview.className = "badge is-good";
    yourReview.textContent = "approved";
    approveBtn.disabled = true;
    approveBtn.innerHTML = `${U.icon("check")}Approved`;
    requestBtn.disabled = true;
    document.getElementById("timeline-approved").hidden = false;
    updateMergeState();
    window.Kustos.toast("Your approval is recorded. e2e is still running.", { tone: "good", title: "Review submitted" });
    window.setTimeout(() => {
      if (!state.merged && !state.changesRequested) markE2EPassed();
    }, 1500);
  });

  requestBtn.addEventListener("click", () => {
    if (state.approved || state.merged || state.changesRequested) return;
    state.changesRequested = true;
    yourReview.className = "badge is-bad";
    yourReview.textContent = "changes requested";
    approveBtn.disabled = true;
    requestBtn.disabled = true;
    updateMergeState();
    appendTimeline("LW", "amber", "requested changes just now", "Please add the exact-match replay test before this lands.");
    window.Kustos.toast("Changes requested. Mara will be notified.", { tone: "warn", title: "Review submitted" });
  });

  mergeBtn.addEventListener("click", () => {
    if (mergeBtn.disabled) return;
    window.Kustos.openModal("merge-modal");
  });

  document.getElementById("confirm-merge").addEventListener("click", () => {
    if (state.merged) return;
    const method = document.querySelector('input[name="merge-method"]:checked').value;
    state.merged = true;
    window.Kustos.closeModal("merge-modal");

    prState.className = "badge is-good";
    prState.innerHTML = '<span class="lamp is-good"></span>Merged';
    mergeBox.classList.remove("is-ready");
    mergeBox.classList.add("is-merged");
    mergeTitle.textContent = "Merged into main";
    mergeDesc.textContent = `${method === "squash" ? "Squash commit" : method === "rebase" ? "Rebased commit" : "Merge commit"} 2f8a1c9 · just now`;
    mergeLamp.innerHTML = '<span class="lamp is-good"></span>';
    mergeBtn.disabled = true;
    mergeBtn.innerHTML = `${U.icon("check")}Merged`;
    approveBtn.disabled = true;
    requestBtn.disabled = true;
    setMergeCheck(mergeReviewState, true, "Approved");
    setMergeCheck(mergeCheckState, true, "e2e passed");
    appendTimeline("LW", "amber", "merged commit 2f8a1c9 into main just now");
    window.Kustos.toast("Pull request #142 merged into main.", { tone: "good", title: "Merged" });
  });

  updateMergeState();

  console.assert(tabs.length === 4, "Pull: four tabs");
  console.assert(panels.length === 4, "Pull: four panels");
  console.assert(Boolean(document.querySelector('[data-diff-line="54"]')), "Pull: annotated diff line exists");
})();
