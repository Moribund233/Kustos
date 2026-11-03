/* Kustos desktop prototype — application chrome.
   Renders titlebar, rail, statusbar and command palette, then wires the
   few interactions the prototype needs to be believable. */
(function () {
  "use strict";

  const U = window.KustosUtil;
  const ico = (name, cls) => U.icon(name, cls || "");

  const body = document.body;
  const surface = body.dataset.surface || "inbox";
  const isReviewWindow = body.dataset.window === "review";

  const RAIL = [
    { id: "inbox", label: "Inbox", icon: "home", href: "index.html", badge: "12", amber: true },
    { id: "working-copy", label: "Working copy", icon: "branch", href: "working-copy.html", badge: "5" },
    { id: "code", label: "Code", icon: "code", href: "editor.html" },
    { id: "pull", label: "Pull requests", icon: "pr", href: "review.html", badge: "4" },
    { id: "issues", label: "Issues", icon: "issue", note: "Issues keeps the web prototype's list + detail layout; it is not redrawn here." },
    { id: "chat", label: "Chat", icon: "chat", href: "windows.html", badge: "3" },
    { id: "agent", label: "Agent", icon: "agent", note: "Agent runs live in the Inbox queue; the run window is not drawn here.", badge: "1", amber: true }
  ];

  /* The rail is deliberately flat: seven surfaces, one instance switcher.
     Web's three-level sidebar belongs to a site you visit, not to a window
     you live in. Surfaces without a page in this prototype say so instead of
     pretending to navigate. */
  function railMarkup() {
    const items = RAIL.map((item) => {
      const active = item.id === surface;
      const badge = item.badge
        ? `<i class="rail-badge${item.amber ? " is-amber" : ""}">${item.badge}</i>`
        : "";
      const attrs = item.href
        ? `href="${item.href}"`
        : `href="#" data-toast="${item.note}"`;
      return `<a class="rail-item${active ? " is-active" : ""}" ${attrs}
        aria-label="${item.label}" title="${item.label}"${active ? ' aria-current="page"' : ""}>
        ${ico(item.icon)}${badge}</a>`;
    }).join("");

    return `<nav class="rail" aria-label="Surfaces">
      ${items}
      <span class="rail-rule" aria-hidden="true"></span>
      <span class="rail-grow"></span>
      <a class="rail-item" href="#" data-toast="Settings: instance profiles, keychain, language servers, updates." aria-label="Settings" title="Settings">${ico("settings")}</a>
      <span class="rail-avatar" title="Lin Wei">LW</span>
    </nav>`;
  }

  function titlebarMarkup() {
    const branch = body.dataset.branch || "feat/collab-cursors";
    const ahead = body.dataset.ahead || "2";
    const behind = body.dataset.behind || "0";
    const conn = body.dataset.conn || "online 46ms";
    const offline = conn.indexOf("offline") === 0;

    const left = isReviewWindow
      ? `<span class="tb-chip">${ico("pr")} #142</span>
         <span class="tb-chip">${ico("branch")} <span class="mono">${branch}</span></span>
         <span class="tb-ahead"><span>↑${ahead}</span><span class="is-down">↓${behind}</span></span>`
      : `<button class="tb-chip" type="button" data-toast="Instance switch belongs in the rail footer — see the design doc §6.2.">
           ${ico("folder")} acme/atlas ${ico("more", "icon")}
         </button>
         <span class="tb-sep" aria-hidden="true"></span>
         <button class="tb-chip" type="button" data-toast="Branch switch runs against the local working copy first.">
           ${ico("branch")} <span class="mono">${branch}</span>
         </button>
         <span class="tb-ahead"><span>↑${ahead}</span><span class="is-down">↓${behind}</span></span>`;

    return `<header class="titlebar">
      <span class="tb-brand">
        <img src="assets/brand/kustos-mark.svg" alt="">
        <span class="tb-word">KUSTOS</span>
      </span>
      <span class="tb-sep" aria-hidden="true"></span>
      ${left}
      <span class="tb-grow"></span>
      <button class="tb-search" type="button" data-palette-open>
        ${ico("search")}<span>Search or run a command</span><span class="kbd">⌘K</span>
      </button>
      <span class="tb-conn${offline ? " is-offline" : ""}">
        <span class="lamp ${offline ? "is-amber" : "is-sage"}" aria-hidden="true"></span>${conn}
      </span>
      <span class="wc">
        <button type="button" data-wc="min" aria-label="Minimise"><span></span></button>
        <button type="button" data-wc="max" aria-label="Maximise"><span></span></button>
        <button type="button" data-wc="close" aria-label="Close"><span></span></button>
      </span>
    </header>`;
  }

  function statusbarMarkup() {
    const d = body.dataset;
    const lsp = d.lsp || (surface === "code" ? "gopls ready" : "no language server");
    const index = d.index || "index 7/7";
    const outbox = d.outbox || "0 pending";
    const sync = d.sync || "synced 12s ago";
    const mode = d.modeLabel || "";

    return `<footer class="statusbar" aria-label="Status">
      <span class="statusitem">${ico("branch")} <span class="mono">${d.branch || "feat/collab-cursors"}</span>
        <span class="faint">·</span> <span class="${d.clean === "0" ? "is-amber" : ""}">${d.cleanText || "clean"}</span></span>
      <span class="sep" aria-hidden="true"></span>
      <span class="statusitem ${lsp.indexOf("missing") === 0 ? "is-amber" : ""}">${ico("pulse")} ${lsp}</span>
      <span class="sep" aria-hidden="true"></span>
      <span class="statusitem">${ico("database")} ${index}</span>
      <span class="grow"></span>
      ${mode ? `<span class="statusitem is-amber">${mode}</span><span class="sep" aria-hidden="true"></span>` : ""}
      <span class="statusitem">${outbox}</span>
      <span class="sep" aria-hidden="true"></span>
      <span class="statusitem">${sync}</span>
    </footer>`;
  }

  const PALETTE_GROUPS = [
    {
      label: "Go to",
      items: [
        { icon: "home", text: "Inbox", hint: "⌘1", href: "index.html" },
        { icon: "branch", text: "Working copy · atlas", hint: "⌘2", href: "working-copy.html" },
        { icon: "code", text: "app/services/agent/runtime.py", hint: "⌘3", href: "editor.html" },
        { icon: "pr", text: "Pull request #142", hint: "⌘4", href: "review.html" }
      ]
    },
    {
      label: "Local",
      items: [
        { icon: "terminal", text: "Open working copy in terminal", hint: "⌥⌘T" },
        { icon: "external", text: "Open file in external editor", hint: "⌘⇧O" },
        { icon: "git-commit", text: "Commit staged changes…", hint: "⌘↵" }
      ]
    },
    {
      label: "Collaboration",
      items: [
        { icon: "users", text: "Join live session on this file", hint: "" },
        { icon: "eye", text: "Observe without editing", hint: "" },
        { icon: "link", text: "Copy link to line", hint: "⌥⌘C" }
      ]
    }
  ];

  function paletteMarkup() {
    const groups = PALETTE_GROUPS.map(
      (group) => `<div class="palette-group">
        <p class="palette-label">${group.label}</p>
        ${group.items
          .map(
            (item, index) =>
              `<a class="palette-item${index === 0 && group === PALETTE_GROUPS[0] ? " is-on" : ""}"
                 href="${item.href || "#"}"${item.href ? "" : ` data-toast="${item.text} is not wired in the prototype."`}>
                ${ico(item.icon)}<span>${item.text}</span>
                ${item.hint ? `<span class="hint">${item.hint}</span>` : ""}
              </a>`
          )
          .join("")}
      </div>`
    ).join("");

    return `<div class="scrim" data-palette hidden>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="palette-input">
          ${ico("search")}
          <input type="text" placeholder="Search files, pull requests, commands…" data-palette-input>
          <span class="kbd">esc</span>
        </div>
        ${groups}
        <div class="palette-foot">
          <span><span class="kbd">↑↓</span> move</span>
          <span><span class="kbd">↵</span> open</span>
          <span><span class="kbd">⌘↵</span> open in new window</span>
        </div>
      </div>
    </div>`;
  }

  /* ------------------------------------------------------------------ mount */

  const win = document.querySelector(".win");
  if (!win) return;

  win.insertAdjacentHTML("afterbegin", titlebarMarkup());
  if (!isReviewWindow) {
    const winBody = win.querySelector(".win-body");
    if (winBody) winBody.insertAdjacentHTML("afterbegin", railMarkup());
  }
  win.insertAdjacentHTML("beforeend", statusbarMarkup());
  body.insertAdjacentHTML("beforeend", paletteMarkup());

  /* ------------------------------------------------------------------- toast */

  let toastTimer = 0;
  function toast(message) {
    let el = document.querySelector(".proto-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "proto-toast";
      el.setAttribute("role", "status");
      el.style.cssText =
        "position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:99;" +
        "padding:8px 14px;border:1px solid var(--line-2);border-radius:8px;" +
        "background:var(--ink-800);color:var(--bone-2);font-size:11.5px;" +
        "box-shadow:var(--shadow-1);max-width:70vw";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-toast]");
    if (target) {
      event.preventDefault();
      toast(target.dataset.toast);
    }
  });

  /* ----------------------------------------------------------------- palette */

  const scrim = document.querySelector("[data-palette]");
  const paletteInput = scrim.querySelector("[data-palette-input]");

  function openPalette() {
    scrim.hidden = false;
    paletteInput.value = "";
    filterPalette("");
    window.setTimeout(() => paletteInput.focus(), 0);
  }

  function closePalette() {
    scrim.hidden = true;
  }

  function filterPalette(query) {
    const q = query.trim().toLowerCase();
    scrim.querySelectorAll(".palette-item").forEach((item) => {
      const match = !q || item.textContent.toLowerCase().includes(q);
      item.hidden = !match;
    });
    scrim.querySelectorAll(".palette-group").forEach((group) => {
      const visible = Array.from(group.querySelectorAll(".palette-item")).some((i) => !i.hidden);
      group.hidden = !visible;
    });
    const first = Array.from(scrim.querySelectorAll(".palette-item")).find((i) => !i.hidden);
    scrim.querySelectorAll(".palette-item").forEach((i) => i.classList.remove("is-on"));
    if (first) first.classList.add("is-on");
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-palette-open]")) {
      event.preventDefault();
      openPalette();
    }
    if (event.target === scrim) closePalette();
  });

  paletteInput.addEventListener("input", () => filterPalette(paletteInput.value));

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      scrim.hidden ? openPalette() : closePalette();
      return;
    }
    if (event.key === "Escape" && !scrim.hidden) closePalette();
  });

  /* ------------------------------------------------------------- selection */

  document.querySelectorAll("[data-selectable]").forEach((container) => {
    container.addEventListener("click", (event) => {
      const row = event.target.closest(".row, .file-row, .tree-item");
      if (!row || !container.contains(row)) return;
      container.querySelectorAll(".is-active, .is-on").forEach((el) => el.classList.remove("is-active", "is-on"));
      row.classList.add(row.classList.contains("tree-item") ? "is-on" : "is-active");
    });
  });

  document.querySelectorAll("[data-seg]").forEach((seg) => {
    seg.addEventListener("click", (event) => {
      const btn = event.target.closest("button");
      if (!btn) return;
      seg.querySelectorAll("button").forEach((b) => b.classList.remove("is-on"));
      btn.classList.add("is-on");
    });
  });

  document.querySelectorAll("[data-tabs]").forEach((tabs) => {
    tabs.addEventListener("click", (event) => {
      const tab = event.target.closest(".tab");
      if (!tab) return;
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-on"));
      tab.classList.add("is-on");
    });
  });

  /* ------------------------------------------------------------ hunk staging */

  function refreshStaged() {
    const staged = document.querySelectorAll(".hunk.is-staged").length;
    const total = document.querySelectorAll(".hunk").length;
    document.querySelectorAll("[data-staged-count]").forEach((el) => {
      el.textContent = staged;
    });
    document.querySelectorAll("[data-unstaged-count]").forEach((el) => {
      el.textContent = total - staged;
    });
    document.querySelectorAll("[data-hunk-total]").forEach((el) => {
      el.textContent = total;
    });
    document.querySelectorAll("[data-staged-chip]").forEach((el) => {
      el.textContent = staged === 0 ? "nothing staged" : `${staged} hunk${staged === 1 ? "" : "s"} staged`;
      el.className = staged === 0 ? "chip" : "chip is-amber";
    });
    const commitBtn = document.querySelector("[data-commit]");
    if (commitBtn) commitBtn.disabled = staged === 0;
  }

  document.addEventListener("click", (event) => {
    const stage = event.target.closest("[data-stage]");
    if (stage) {
      const hunk = stage.closest(".hunk");
      hunk.classList.toggle("is-staged");
      stage.textContent = hunk.classList.contains("is-staged") ? "Unstage" : "Stage hunk";
      refreshStaged();
    }
    const commit = event.target.closest("[data-commit]");
    if (commit) {
      toast("Committed to feat/collab-cursors locally. Nothing is pushed yet.");
    }
  });

  refreshStaged();

  /* --------------------------------------------------------------- doc mode */

  const MODE_COPY = {
    local: {
      chip: "Local · on disk",
      save: "Save to disk",
      note: "Edits write to the working tree. Your team cannot see them until you commit and push."
    },
    live: {
      chip: "Live · 3 editing",
      save: "Save to draft branch",
      note: "Edits go to the shared CRDT document and are saved to collab/draft-feat/collab-cursors. Nothing is written to disk."
    },
    observe: {
      chip: "Read-only · observing",
      save: "Read-only",
      note: "You are watching two collaborators. Editing is disabled until you join the session."
    }
  };

  function applyMode(mode) {
    body.dataset.mode = mode;
    const copy = MODE_COPY[mode] || MODE_COPY.local;
    document.querySelectorAll("[data-mode-label]").forEach((el) => {
      el.textContent = copy.chip;
    });
    document.querySelectorAll("[data-save-label]").forEach((el) => {
      el.textContent = copy.save;
    });
    document.querySelectorAll("[data-save]").forEach((el) => {
      el.disabled = mode === "observe";
    });
    document.querySelectorAll("[data-mode-note]").forEach((el) => {
      el.textContent = copy.note;
    });
    document.querySelectorAll("[data-mode-set]").forEach((el) => {
      el.classList.toggle("is-on", el.dataset.modeSet === mode);
    });
  }

  document.addEventListener("click", (event) => {
    const setter = event.target.closest("[data-mode-set]");
    if (setter) {
      applyMode(setter.dataset.modeSet);
      toast(
        setter.dataset.modeSet === "live"
          ? "Preflight passed: branch aligned, local changes committed, 3 people online."
          : setter.dataset.modeSet === "observe"
            ? "Observing only. Join the session to edit."
            : "Left the session. Live content was written back to disk."
      );
    }
    const save = event.target.closest("[data-save]");
    if (save && !save.disabled) {
      toast(body.dataset.mode === "live" ? "Saved to collab draft branch." : "Saved 1 file to disk.");
    }
  });

  if (body.dataset.mode) applyMode(body.dataset.mode);

  /* ------------------------------------------------------------ window chrome */

  document.querySelectorAll("[data-wc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.wc;
      if (action === "max") {
        document.querySelector(".win").classList.toggle("is-max");
        return;
      }
      toast(
        action === "close"
          ? "Closing the window hides Kustos to the tray; it keeps syncing."
          : "Minimised to the tray with an unread badge."
      );
    });
  });
})();
