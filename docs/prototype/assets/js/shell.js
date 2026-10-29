/* Application shell: sidebar, topbar, palette, popovers, modals, toasts. */
(function () {
  "use strict";

  const U = window.KustosUtil;
  const page = document.body.dataset.page || "home";
  const ico = (name, cls) => U.icon(name, cls || "");

  /* Global admin is a different axis from a repository role: User.is_admin
     gates /api/app/*, while "developer" is a membership role inside a repo.
     The prototype persona is both, but `?as=member` renders the member view
     so the admin-only surfaces can be checked against their guard. */
  const viewerParam = new URLSearchParams(window.location.search).get("as");
  const IS_ADMIN = viewerParam !== "member";
  const viewerRoleLabel = IS_ADMIN ? "global admin" : "repository owner";
  document.body.dataset.viewer = IS_ADMIN ? "admin" : "member";

  const NAV_WORKSPACE = [
    { id: "home", label: "Overview", href: "index.html", icon: "home" },
    { id: "agent", label: "Agent", href: "agent.html", icon: "agent", badge: "2", amber: true }
  ];

  const NAV_REPO = [
    { id: "code", label: "Code", href: "code.html", icon: "code" },
    { id: "pull", label: "Pull requests", href: "pull.html", icon: "pr", badge: "4" },
    { id: "issues", label: "Issues", href: "issues.html", icon: "issue", badge: "12" },
    { id: "chat", label: "Chat", href: "chat.html", icon: "chat", badge: "3" }
  ];

  function navMarkup(items) {
    return items.map((item) => {
      const active = item.id === page;
      const label = item.badge ? `${item.label}, ${item.badge}` : item.label;
      return `<a class="nav-item${active ? " is-active" : ""}" data-nav="${item.id}" href="${item.href}" aria-label="${label}" title="${item.label}"${active ? ' aria-current="page"' : ""}>
        ${ico(item.icon)}
        <span>${item.label}</span>
        ${item.badge ? `<span class="nav-badge${item.amber ? " is-amber" : ""}" aria-hidden="true">${item.badge}</span>` : ""}
      </a>`;
    }).join("");
  }

  /* The sidebar shows three layers: personal surfaces, repo-scoped
     surfaces, then the repo list itself with the current object nested
     underneath the active repo. */
  const HERE = {
    code: { view: "Code", detail: "app/services/lfs.py" },
    pull: { view: "Pull requests", detail: "#142" },
    issues: { view: "Issues", detail: "#94" },
    chat: { view: "Chat", detail: "#atlas" }
  };

  const shell = `
    <aside class="sidebar" id="sidebar" aria-label="Primary">
      <div class="brand">
        <a class="brand-link" href="index.html" aria-label="KUSTOS — self-hosted home">
          <img class="brand-mark" src="assets/brand/kustos-mark.svg" width="31" height="31" alt="">
          <span class="brand-text">
            <span class="brand-word">KUSTOS</span>
            <span class="brand-sub" style="display:block">SELF-HOSTED</span>
          </span>
        </a>
      </div>

      <div class="workspace-switch is-static" aria-label="Instance — Northstar Labs">
        <span class="workspace-avatar" aria-hidden="true">N</span>
        <span class="workspace-copy">
          <span class="workspace-name">Northstar Labs</span>
          <span class="workspace-meta" aria-hidden="true">meridian.northstar.dev</span>
        </span>
      </div>

      <div class="sidebar-nav">
        <nav class="nav-group" aria-label="Personal">
          <p class="nav-label">Personal</p>
          ${navMarkup(NAV_WORKSPACE)}
        </nav>
        <nav class="nav-group" aria-label="Repository">
          <p class="nav-label">Repository</p>
          ${navMarkup(NAV_REPO)}
        </nav>
        <div class="nav-group nav-group-repos">
          <p class="nav-label">Repositories</p>
          <a class="repo-item${HERE[page] ? " is-active" : ""}" href="code.html" aria-label="lin/atlas — active repository" title="lin/atlas"${HERE[page] ? ' aria-current="true"' : ""}>
            <span class="repo-dot" aria-hidden="true"></span>
            <span class="repo-copy">
              <span class="repo-name">atlas</span>
              <span class="repo-meta">lin · pushed 2m ago</span>
            </span>
            <span class="repo-count" aria-hidden="true">4</span>
          </a>
          ${HERE[page] ? `<div class="repo-here">
            <span class="repo-here-view">${HERE[page].view}</span>
            <span class="repo-here-detail mono">${HERE[page].detail}</span>
          </div>` : ""}
          <button class="repo-item" type="button" aria-label="lin/harbor" title="lin/harbor" data-toast="This prototype includes only lin/atlas.">
            <span class="repo-dot" aria-hidden="true"></span>
            <span class="repo-copy">
              <span class="repo-name">harbor</span>
              <span class="repo-meta">lin · pushed 1h ago</span>
            </span>
            <span class="repo-count" aria-hidden="true">1</span>
          </button>
          <button class="repo-item" type="button" aria-label="lin/lantern" title="lin/lantern" data-toast="This prototype includes only lin/atlas.">
            <span class="repo-dot" aria-hidden="true"></span>
            <span class="repo-copy">
              <span class="repo-name">lantern</span>
              <span class="repo-meta">lin · indexing</span>
            </span>
            <span class="repo-count" aria-hidden="true">0</span>
          </button>
        </div>
        ${IS_ADMIN ? `<nav class="nav-group nav-group-instance" aria-label="Instance">
          <p class="nav-label">Instance</p>
          <a class="nav-item nav-item-admin${page === "admin" ? " is-active" : ""}" data-nav="admin" href="admin.html" title="Admin console"${page === "admin" ? ' aria-current="page"' : ""}>
            ${ico("shield")}
            <span>Admin console</span>
            <span class="nav-tag" aria-hidden="true">admin</span>
          </a>
        </nav>` : ""}
      </div>

      <div class="side-bottom">
        <button class="user-row" type="button" data-popover="user-menu" aria-haspopup="menu" aria-expanded="false" aria-label="LW — Lin Wei, ${viewerRoleLabel} — account menu">
          <span class="avatar avatar-sm is-amber" aria-hidden="true">LW</span>
          <span class="user-copy">
            <span class="user-name">Lin Wei</span>
            <span class="user-role">${IS_ADMIN ? "global admin" : "owner · atlas"}</span>
          </span>
          ${ico("more", "icon-sm")}
        </button>

        <div class="menu side-user-menu" id="user-menu" role="menu" hidden>
          <p class="menu-label">Lin Wei · @lin</p>
          <button class="menu-item" role="menuitem" type="button" data-toast="Profile and preferences are outside this prototype.">${ico("user")} Profile & preferences</button>
          <button class="menu-item" role="menuitem" type="button" data-toast="SSH keys live in account settings.">${ico("key")} SSH & access keys</button>
          ${IS_ADMIN ? `<a class="menu-item" role="menuitem" href="admin.html">${ico("shield")} Admin console <span class="menu-hint">instance</span></a>` : ""}
          <button class="menu-item" role="menuitem" type="button" data-toast="Shortcuts: Ctrl K search · G then H home · A agent.">${ico("command")} Keyboard shortcuts</button>
          <div class="menu-sep"></div>
          <a class="menu-item" role="menuitem" href="login.html">${ico("arrow-up-right")} Sign out</a>
        </div>
      </div>
    </aside>

    <div class="scrim" id="scrim" hidden></div>

    <div class="workspace">
      <header class="topbar">
        <button class="icon-btn sidebar-toggle" id="sidebar-toggle" type="button" aria-label="Open navigation" aria-expanded="false">
          ${ico("panel-left")}
        </button>
        <nav class="crumbs" id="crumbs" aria-label="Breadcrumb"></nav>
        <button class="search-trigger" id="search-trigger" type="button" aria-label="Search Kustos — Ctrl K">
          ${ico("search", "icon-sm")}
          <span class="search-trigger-label">Search Kustos…</span>
          <kbd class="kbd" data-kbd>Ctrl K</kbd>
        </button>
        <div class="topbar-actions">
          <a class="agent-pill" href="agent.html">
            <span class="lamp is-warn is-live" aria-hidden="true"></span>
            <span><strong>Agent</strong> · 2 active</span>
          </a>
          <button class="icon-btn" id="notif-btn" type="button" aria-label="Notifications" aria-haspopup="dialog" aria-expanded="false">
            ${ico("bell")}
            <span class="unread-dot" id="unread-dot" aria-hidden="true"></span>
          </button>
          <button class="btn btn-primary btn-sm" id="new-btn" type="button" aria-haspopup="menu" aria-expanded="false">
            ${ico("plus")} New
          </button>

          <div class="popover" id="notif-popover" role="dialog" aria-label="Notifications" hidden>
            <div class="popover-head">
              <h3>Notifications</h3>
              <button class="fine" type="button" id="mark-read">Mark all read</button>
            </div>
            <div class="popover-list">
              <button class="notif is-unread" type="button" data-href="pull.html">
                <span class="notif-icon">${ico("pr", "icon-sm")}</span>
                <span class="notif-copy"><p>Kustos left a blocking review on <strong>#142</strong>.</p><time>12 min ago</time></span>
              </button>
              <button class="notif is-unread" type="button" data-href="agent.html">
                <span class="notif-icon">${ico("agent", "icon-sm")}</span>
                <span class="notif-copy"><p>Run <strong>A-1042</strong> is waiting for your approval.</p><time>18 min ago</time></span>
              </button>
              <button class="notif" type="button" data-href="issues.html">
                <span class="notif-icon is-info">${ico("issue", "icon-sm")}</span>
                <span class="notif-copy"><p>Noor assigned you <strong>#94</strong> — agent approval reliability.</p><time>1 h ago</time></span>
              </button>
              <button class="notif" type="button" data-href="chat.html">
                <span class="notif-icon is-good">${ico("chat", "icon-sm")}</span>
                <span class="notif-copy"><p>Mara mentioned you in <strong>#atlas</strong>.</p><time>2 h ago</time></span>
              </button>
            </div>
          </div>

          <div class="menu" id="new-menu" role="menu" hidden>
            <p class="menu-label">Create</p>
            <a class="menu-item" role="menuitem" href="issues.html?new=1">${ico("issue")} New issue <span class="menu-hint">I</span></a>
            <button class="menu-item" role="menuitem" type="button" data-toast="Push a branch first; then open a pull request from the compare view.">${ico("pr")} New pull request</button>
            <button class="menu-item" role="menuitem" type="button" data-open-run>${ico("agent")} Start agent run <span class="menu-hint">A</span></button>
            <div class="menu-sep"></div>
            <button class="menu-item" role="menuitem" type="button" data-toast="Repository creation is outside this prototype (POST /api/v1/repositories).">${ico("book")} New repository</button>
          </div>
        </div>
      </header>

      <main class="main" id="main"></main>
    </div>

    <div class="noise" aria-hidden="true"></div>
    <div class="toast-stack" id="toasts" aria-live="polite" aria-atomic="false"></div>

    <div class="overlay palette-overlay" id="palette" hidden>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="palette-input">
          ${ico("search")}
          <input id="palette-input" type="text" autocomplete="off" spellcheck="false" placeholder="Search repositories, pull requests, issues, commands…" aria-label="Search Kustos">
          <kbd class="kbd">Esc</kbd>
        </div>
        <div class="palette-results" id="palette-results"></div>
        <div class="palette-foot">
          <span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> navigate</span>
          <span><kbd class="kbd">↵</kbd> open</span>
          <span><kbd class="kbd">esc</kbd> close</span>
        </div>
      </div>
    </div>

    <div class="overlay" id="run-modal" hidden>
      <form class="modal" id="run-form" role="dialog" aria-modal="true" aria-labelledby="run-modal-title">
        <div class="modal-head">
          <div>
            <p class="eyebrow">Kustos agent</p>
            <h2 id="run-modal-title">Start a run</h2>
            <p class="fine">Kustos reads the repository through tools. Writes pause for approval.</p>
          </div>
          <button class="icon-btn" type="button" data-close aria-label="Close">${ico("x")}</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label for="run-repo">Repository</label>
            <select class="select" id="run-repo">
              <option>lin/atlas</option>
              <option>lin/harbor</option>
              <option>lin/lantern</option>
            </select>
          </div>
          <div class="field">
            <label for="run-prompt">Prompt</label>
            <textarea class="textarea" id="run-prompt" rows="4" required placeholder="What should Kustos look into?"></textarea>
            <span class="field-hint">Be concrete. Kustos can search code, read files, inspect diffs and open issues.</span>
          </div>
          <div class="field">
            <label for="run-model">Model override</label>
            <select class="select" id="run-model">
              <option value="">Instance default</option>
              <option>gpt-4o-mini</option>
              <option>gpt-4.1-mini</option>
              <option>claude-3.5-sonnet</option>
            </select>
            <span class="field-hint">Optional. The instance default applies unless you override it for this run.</span>
          </div>
          <label class="check">
            <input type="checkbox" id="run-write" checked>
            <span>Allow write tools <span class="fine">Each write pauses for an explicit approval. Read-only triggers never receive write access.</span></span>
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-quiet" type="button" data-close>Cancel</button>
          <button class="btn btn-primary" type="submit">${ico("play")} Queue run</button>
        </div>
      </form>
    </div>
  `;

  const mount = document.getElementById("shell");
  mount.outerHTML = shell;

  const template = document.getElementById("page-template");
  if (template) {
    document.getElementById("main").appendChild(template.content.cloneNode(true));
    template.remove();
  }

  /* Breadcrumb ------------------------------------------------------- */
  const crumbs = document.getElementById("crumbs");
  const crumbParts = (document.body.dataset.crumb || "Kustos").split("|").map((part) => part.trim()).filter(Boolean);
  crumbs.innerHTML = crumbParts.map((part, index) => {
    const isLast = index === crumbParts.length - 1;
    return `${index > 0 ? '<span class="sep" aria-hidden="true">/</span>' : ""}<span class="${isLast ? "current" : ""}"${isLast ? ' aria-current="page"' : ""}>${U.escapeHtml(part)}</span>`;
  }).join("");

  document.title = document.body.dataset.title || "Kustos";

  /* Platform shortcut label ----------------------------------------- */
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  U.qsa("[data-kbd]").forEach((node) => {
    node.textContent = isMac ? "⌘ K" : "Ctrl K";
  });

  /* Toast ------------------------------------------------------------ */
  const toastStack = document.getElementById("toasts");

  function toast(message, options) {
    const opts = options || {};
    const tone = opts.tone || "info";
    const iconName = tone === "good" ? "check-circle" : tone === "bad" ? "alert" : tone === "warn" ? "alert" : "spark";
    const node = document.createElement("div");
    node.className = `toast is-${tone}`;
    node.innerHTML = `
      ${ico(iconName)}
      <div class="toast-copy">${opts.title ? `<strong>${U.escapeHtml(opts.title)}</strong>` : ""}<span>${U.escapeHtml(message)}</span></div>
      <button class="toast-close" type="button" aria-label="Dismiss">${ico("x", "icon-xs")}</button>
    `;
    toastStack.appendChild(node);
    const remove = () => {
      node.style.opacity = "0";
      node.style.transform = "translateY(6px)";
      window.setTimeout(() => node.remove(), 160);
    };
    node.querySelector(".toast-close").addEventListener("click", remove);
    window.setTimeout(remove, opts.duration || 4600);
  }

  async function copy(text, label) {
    const ok = await U.copyText(text);
    toast(ok ? `${label || "Copied"} — ${text}` : "Copy failed. Select the text manually.", {
      tone: ok ? "good" : "bad",
      title: ok ? "Copied" : "Clipboard unavailable"
    });
  }

  /* Modal helpers ---------------------------------------------------- */
  let lastFocus = null;

  function openModal(id) {
    const overlay = typeof id === "string" ? document.getElementById(id) : id;
    if (!overlay) return;
    lastFocus = document.activeElement;
    overlay.hidden = false;
    document.body.classList.add("is-locked");
    const focusable = overlay.querySelector("input, textarea, select, button:not([data-close]), [href]");
    window.setTimeout(() => {
      const input = overlay.querySelector("input:not([type=checkbox]), textarea");
      (input || focusable || overlay).focus();
    }, 40);
  }

  function closeModal(id) {
    const overlay = typeof id === "string" ? document.getElementById(id) : id;
    if (!overlay) return;
    overlay.hidden = true;
    if (!U.qsa(".overlay").some((node) => !node.hidden)) {
      document.body.classList.remove("is-locked");
    }
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  U.qsa(".overlay").forEach((overlay) => {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeModal(overlay);
    });
    overlay.querySelectorAll("[data-close]").forEach((button) => {
      button.addEventListener("click", () => closeModal(overlay));
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = U.qsa(".overlay").filter((node) => !node.hidden).pop();
    if (open) {
      closeModal(open);
      return;
    }
    closePopovers();
    closeSidebar();
  });

  /* Focus trap for modals ------------------------------------------- */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const overlay = U.qsa(".overlay").filter((node) => !node.hidden).pop();
    if (!overlay) return;
    const focusables = U.qsa(
      'a[href], button:not(:disabled), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      overlay
    ).filter((node) => node.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  /* Popovers --------------------------------------------------------- */
  const popoverButtons = {
    "notif-popover": document.getElementById("notif-btn"),
    "new-menu": document.getElementById("new-btn")
  };
  const userRow = U.qs('[data-popover="user-menu"]');
  const userMenu = document.getElementById("user-menu");

  function closePopovers(except) {
    Object.entries(popoverButtons).forEach(([id, button]) => {
      const pop = document.getElementById(id);
      if (!pop || id === except) return;
      pop.hidden = true;
      button.setAttribute("aria-expanded", "false");
    });
    if (userMenu && userRow && except !== "user-menu") {
      userMenu.hidden = true;
      userRow.setAttribute("aria-expanded", "false");
    }
  }

  function togglePopover(id, button) {
    const pop = document.getElementById(id);
    if (!pop) return;
    const willOpen = pop.hidden;
    closePopovers(willOpen ? id : null);
    pop.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
    if (willOpen && id === "notif-popover") {
      document.getElementById("unread-dot").hidden = true;
    }
  }

  Object.entries(popoverButtons).forEach(([id, button]) => {
    if (!button) return;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePopover(id, button);
    });
  });

  if (userRow && userMenu) {
    userRow.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = userMenu.hidden;
      closePopovers(willOpen ? "user-menu" : null);
      userMenu.hidden = !willOpen;
      userRow.setAttribute("aria-expanded", String(willOpen));
    });
  }

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".popover") && !event.target.closest(".menu") &&
        !event.target.closest("#notif-btn") && !event.target.closest("#new-btn") &&
        !event.target.closest('[data-popover="user-menu"]')) {
      closePopovers();
    }
  });

  document.getElementById("mark-read").addEventListener("click", () => {
    U.qsa(".notif.is-unread").forEach((node) => node.classList.remove("is-unread"));
    document.getElementById("unread-dot").hidden = true;
    toast("Notifications marked as read.", { tone: "good" });
  });

  U.qsa("#notif-popover .notif").forEach((node) => {
    node.addEventListener("click", () => {
      const href = node.dataset.href;
      if (href) window.location.href = href;
    });
  });

  /* Sidebar / scrim -------------------------------------------------- */
  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("scrim");
  const sidebarToggle = document.getElementById("sidebar-toggle");

  function openSidebar() {
    sidebar.classList.add("is-open");
    scrim.hidden = false;
    sidebarToggle.setAttribute("aria-expanded", "true");
    document.body.classList.add("is-locked");
  }

  function closeSidebar() {
    sidebar.classList.remove("is-open");
    scrim.hidden = true;
    sidebarToggle.setAttribute("aria-expanded", "false");
    if (!U.qsa(".overlay").some((node) => !node.hidden)) {
      document.body.classList.remove("is-locked");
    }
  }

  sidebarToggle.addEventListener("click", () => {
    if (sidebar.classList.contains("is-open")) closeSidebar();
    else openSidebar();
  });
  scrim.addEventListener("click", closeSidebar);

  /* Command palette -------------------------------------------------- */
  const palette = document.getElementById("palette");
  const paletteInput = document.getElementById("palette-input");
  const paletteResults = document.getElementById("palette-results");
  let paletteVisible = [];
  let paletteIndex = 0;

  const PALETTE = [
    { group: "Navigate", label: "Overview", hint: "Watch", icon: "home", href: "index.html", keywords: "home watch dashboard overview" },
    { group: "Navigate", label: "Code", hint: "atlas", icon: "code", href: "code.html", keywords: "code repository files browse" },
    { group: "Navigate", label: "Pull requests", hint: "4 open", icon: "pr", href: "pull.html", keywords: "pr review merge pull request" },
    { group: "Navigate", label: "Issues", hint: "12 open", icon: "issue", href: "issues.html", keywords: "issue bug task" },
    { group: "Navigate", label: "Agent", hint: "2 active", icon: "agent", href: "agent.html", keywords: "agent ai run tools approval" },
    { group: "Navigate", label: "Chat", hint: "#atlas", icon: "chat", href: "chat.html", keywords: "chat room messages realtime" },
    { group: "Repositories", label: "lin/atlas", hint: "Python · main", icon: "code", href: "code.html", keywords: "repo python atlas" },
    { group: "Repositories", label: "lin/harbor", hint: "Go · main", icon: "code", href: "code.html", keywords: "repo go harbor" },
    { group: "Repositories", label: "lin/lantern", hint: "TypeScript · main", icon: "code", href: "code.html", keywords: "repo typescript design system" },
    { group: "Pull requests", label: "#142 Harden LFS transfer token scope", hint: "Open", icon: "pr", href: "pull.html", keywords: "lfs token security mara review" },
    { group: "Pull requests", label: "#139 Bound semantic recall to the default branch", hint: "Open", icon: "pr", href: "pull.html", keywords: "search semantic branch ilya" },
    { group: "Issues", label: "#94 Agent approval can be lost on worker restart", hint: "High", icon: "issue", href: "issues.html", keywords: "agent approval worker reliability" },
    { group: "Issues", label: "#91 Search index falls back to Git tree on monorepos", hint: "High", icon: "issue", href: "issues.html", keywords: "search index monorepo performance" },
    { group: "Agent runs", label: "A-1042 · Review LFS token scope", hint: "Approval", icon: "agent", href: "agent.html", keywords: "agent lfs token approval run" },
    { group: "Agent runs", label: "A-1039 · Triage search fallback", hint: "Succeeded", icon: "agent", href: "agent.html", keywords: "agent search fallback run" },
    ...(IS_ADMIN ? [{ group: "Instance", label: "Admin console", hint: "admin only", icon: "shield", href: "admin.html", keywords: "admin instance components redis audit logs config acl" }] : []),
    { group: "Actions", label: "Start a new agent run", hint: "A", icon: "zap", action: "run", keywords: "new agent run start create" },
    { group: "Actions", label: "Copy clone URL", hint: "SSH", icon: "copy", action: "copy-clone", keywords: "clone git ssh url copy" },
    { group: "Actions", label: "Sign out", hint: "", icon: "arrow-up-right", href: "login.html", keywords: "logout sign out" }
  ];

  function openPalette() {
    closePopovers();
    palette.hidden = false;
    document.body.classList.add("is-locked");
    paletteInput.value = "";
    paletteIndex = 0;
    renderPalette("");
    window.setTimeout(() => paletteInput.focus(), 30);
  }

  function closePalette() {
    palette.hidden = true;
    if (!U.qsa(".overlay").some((node) => !node.hidden)) {
      document.body.classList.remove("is-locked");
    }
  }

  function renderPalette(query) {
    const q = query.trim().toLowerCase();
    paletteVisible = PALETTE.filter((item) => {
      if (!q) return true;
      return `${item.label} ${item.group} ${item.hint} ${item.keywords}`.toLowerCase().includes(q);
    });
    paletteIndex = Math.min(paletteIndex, Math.max(paletteVisible.length - 1, 0));

    if (!paletteVisible.length) {
      paletteResults.innerHTML = '<div class="palette-empty">No matches. Try “lfs”, “agent” or “issue”.</div>';
      return;
    }

    const groups = new Map();
    paletteVisible.forEach((item) => {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    });

    let flat = 0;
    paletteResults.innerHTML = Array.from(groups.entries()).map(([group, items]) => {
      const rows = items.map((item) => {
        const index = flat++;
        return `<button class="palette-item${index === paletteIndex ? " is-selected" : ""}" type="button" data-index="${index}">
          ${ico(item.icon)}
          <span>${U.escapeHtml(item.label)}</span>
          ${item.hint ? `<span class="palette-hint">${U.escapeHtml(item.hint)}</span>` : ""}
        </button>`;
      }).join("");
      return `<div class="palette-group"><p class="palette-group-label">${group}</p>${rows}</div>`;
    }).join("");

    paletteResults.querySelectorAll(".palette-item").forEach((node) => {
      node.addEventListener("click", () => runPaletteItem(Number(node.dataset.index)));
    });
  }

  function runPaletteItem(index) {
    const item = paletteVisible[index];
    if (!item) return;
    closePalette();
    if (item.href) {
      window.location.href = item.href;
      return;
    }
    if (item.action === "run") {
      openRunModal();
      return;
    }
    if (item.action === "copy-clone") {
      copy("git@kustos.meridian.dev:lin/atlas.git", "Clone URL copied");
    }
  }

  function movePalette(delta) {
    if (!paletteVisible.length) return;
    paletteIndex = (paletteIndex + delta + paletteVisible.length) % paletteVisible.length;
    renderPalette(paletteInput.value);
    const selected = paletteResults.querySelector(".palette-item.is-selected");
    if (selected) selected.scrollIntoView({ block: "nearest" });
  }

  document.getElementById("search-trigger").addEventListener("click", openPalette);
  paletteInput.addEventListener("input", () => {
    paletteIndex = 0;
    renderPalette(paletteInput.value);
  });
  paletteInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      movePalette(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      movePalette(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runPaletteItem(paletteIndex);
    } else if (event.key === "Escape") {
      closePalette();
    }
  });
  palette.addEventListener("click", (event) => {
    if (event.target === palette) closePalette();
  });

  /* New run ---------------------------------------------------------- */
  const runForm = document.getElementById("run-form");

  function openRunModal(prompt) {
    closePopovers();
    document.getElementById("run-prompt").value = prompt || "";
    document.getElementById("run-write").checked = true;
    openModal("run-modal");
  }

  function startRun(detail) {
    if (document.body.dataset.page === "agent" && window.KustosAgentRuns) {
      window.dispatchEvent(new CustomEvent("kustos:start-run", { detail }));
      return;
    }
    try {
      sessionStorage.setItem("kustos:new-run", JSON.stringify(detail));
    } catch (error) {
      /* sessionStorage can be unavailable on file:// in hardened browsers */
    }
    window.location.href = "agent.html";
  }

  runForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = document.getElementById("run-prompt").value.trim();
    if (!prompt) {
      document.getElementById("run-prompt").focus();
      return;
    }
    const detail = {
      prompt,
      repo: document.getElementById("run-repo").value,
      model: document.getElementById("run-model").value || "",
      allowWrite: document.getElementById("run-write").checked
    };
    closeModal("run-modal");
    toast("Run queued for " + detail.repo + ".", { tone: "good", title: "Agent run queued" });
    startRun(detail);
  });

  document.addEventListener("click", (event) => {
    const openRun = event.target.closest("[data-open-run]");
    if (openRun) {
      event.preventDefault();
      openRunModal(openRun.dataset.prompt || "");
      return;
    }

    const close = event.target.closest("[data-close]");
    if (close) {
      const overlay = close.closest(".overlay");
      if (overlay) closeModal(overlay);
      return;
    }

    const toastButton = event.target.closest("[data-toast]");
    if (toastButton) {
      event.preventDefault();
      toast(toastButton.dataset.toast, { tone: toastButton.dataset.tone || "info" });
      return;
    }

    const copyButton = event.target.closest("[data-copy]");
    if (copyButton) {
      event.preventDefault();
      copy(copyButton.dataset.copy, copyButton.dataset.copyLabel || "Copied");
    }
  });

  /* Global shortcuts ------------------------------------------------ */
  document.addEventListener("keydown", (event) => {
    const tag = (event.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select" || event.target.isContentEditable;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (palette.hidden) openPalette();
      else closePalette();
      return;
    }

    if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      openPalette();
      return;
    }

    if (event.key.toLowerCase() === "a" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      openRunModal();
    }
  });

  /* Floating panels -------------------------------------------------- */
  /* Secondary surfaces (inspector, facts, merge controls) live above the
     canvas instead of taking a column from it. One panel per stage, the
     dock switches which pane it shows. */
  function panelStage(node) {
    return node.closest(".stage");
  }

  function openPanel(stage, pane) {
    const panel = stage.querySelector(".float-panel");
    if (!panel) return;
    const tabs = U.qsa("[data-panel-tab]", stage);
    const panes = U.qsa("[data-pane]", panel);
    const active = pane || (panel.querySelector(".float-pane.is-active") || panes[0] || {}).dataset?.pane;
    if (!active) return;

    tabs.forEach((tab) => {
      const on = tab.dataset.panelTab === active;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-expanded", String(on));
    });
    panes.forEach((node) => node.classList.toggle("is-active", node.dataset.pane === active));

    const source = tabs.find((tab) => tab.dataset.panelTab === active);
    const title = panel.querySelector(".float-head h2");
    const kicker = panel.querySelector(".float-head .eyebrow");
    if (source && title && source.dataset.panelLabel) title.textContent = source.dataset.panelLabel;
    if (source && kicker && source.dataset.panelKicker) kicker.textContent = source.dataset.panelKicker;

    panel.classList.add("is-open");
    panel.inert = false;
    panel.removeAttribute("aria-hidden");
    stage.classList.add("is-paneled");
  }

  function closePanel(stage) {
    const panel = stage.querySelector(".float-panel");
    if (!panel) return;
    panel.classList.remove("is-open");
    panel.inert = true;
    panel.setAttribute("aria-hidden", "true");
    stage.classList.remove("is-paneled");
    U.qsa("[data-panel-tab]", stage).forEach((tab) => {
      tab.classList.remove("is-active");
      tab.setAttribute("aria-expanded", "false");
    });
  }

  function togglePanel(stage, pane) {
    const panel = stage.querySelector(".float-panel");
    if (!panel) return;
    const current = panel.querySelector(".float-pane.is-active");
    const same = panel.classList.contains("is-open") && current && current.dataset.pane === pane;
    if (same) closePanel(stage);
    else openPanel(stage, pane);
  }

  document.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-panel-tab]");
    if (tab) {
      event.preventDefault();
      togglePanel(panelStage(tab), tab.dataset.panelTab);
      return;
    }
    const closer = event.target.closest("[data-panel-close]");
    if (closer) {
      event.preventDefault();
      closePanel(panelStage(closer));
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    U.qsa(".stage.is-paneled").forEach(closePanel);
  });

  // Dock buttons get a native tooltip; the icon alone is not self-describing.
  U.qsa(".dock-btn").forEach((btn) => {
    if (btn.dataset.panelLabel) btn.title = btn.dataset.panelLabel;
  });

  // Panels start inert so a closed panel is out of the tab order.
  U.qsa(".stage .float-panel").forEach((panel) => {
    if (!panel.classList.contains("is-open")) {
      panel.inert = true;
      panel.setAttribute("aria-hidden", "true");
    }
  });

  // A stage can ask for a pane on load: data-panel-default="symbols".
  U.qsa(".stage[data-panel-default]").forEach((stage) => {
    const pane = stage.dataset.panelDefault;
    if (pane) openPanel(stage, pane);
  });

  /* Expose a small API for page scripts ----------------------------- */
  window.Kustos = {
    page,
    toast,
    copy,
    openModal,
    closeModal,
    openRunModal,
    openPalette,
    openPanel,
    closePanel,
    ico
  };
})();
