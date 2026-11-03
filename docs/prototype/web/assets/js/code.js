/* Repository code browser */
(function () {
  "use strict";

  const U = window.KustosUtil;
  const DATA = window.KUSTOS_CODE;
  const codeLines = document.getElementById("code-lines");
  const pathCrumbs = document.getElementById("path-crumbs");
  const codePath = document.getElementById("code-path");
  const codeMeta = document.getElementById("code-meta");
  const codeSize = document.getElementById("code-size");
  const symbolList = document.getElementById("symbol-list");
  const insight = document.getElementById("file-insight");
  const treeFilter = document.getElementById("tree-filter");
  let currentPath = "app/services/lfs.py";

  function fileData(path) {
    return DATA[path];
  }

  function pathMarkup(path) {
    const parts = path.split("/");
    return parts.map((part, index) => {
      const isLast = index === parts.length - 1;
      return `${index ? '<span class="path-sep" aria-hidden="true">/</span>' : ""}<span class="${isLast ? "path-current" : ""}">${U.escapeHtml(part)}</span>`;
    }).join("");
  }

  function annotationMarkup(comment) {
    return `<div class="code-annot" role="note">
      <div class="annot-head">
        <span class="avatar avatar-sm is-bot" aria-hidden="true">${U.icon("agent", "icon-xs")}</span>
        <span class="annot-author">${U.escapeHtml(comment.author)}</span>
        <span class="badge is-warn">review</span>
        <span class="annot-time">${U.escapeHtml(comment.time)}</span>
      </div>
      <p class="annot-body">${comment.body}</p>
      <div class="annot-actions">
        <a class="text-link" href="${comment.href}">${U.escapeHtml(comment.hrefLabel)} <span aria-hidden="true">↗</span></a>
        <button class="text-link" type="button" data-toast="Threaded replies are part of the file-comment controller.">Reply</button>
      </div>
    </div>`;
  }

  /* Symbols are rendered as a tree: a class owns the methods declared
     beneath it, so the outline reads like the file, not like a flat tag
     cloud. */
  function symbolTreeMarkup(file) {
    const entries = file.symbols.map((symbol) => ({
      ...symbol,
      line: file.lines.findIndex((line) => line.includes(symbol.match)) + 1
    }));

    const classLines = [];
    file.lines.forEach((line, index) => {
      const match = line.match(/^class\s+(\w+)/);
      if (match) classLines.push({ name: match[1], line: index + 1 });
    });

    const ownerOf = (entry) => {
      if (entry.kind === "class") return null;
      const text = file.lines[entry.line - 1] || "";
      // Only indented symbols belong to the class above them.
      if (!/^\s+\S/.test(text)) return null;
      const owners = classLines.filter((cls) => cls.line < entry.line);
      return owners.length ? owners[owners.length - 1].name : null;
    };

    const row = (entry) => {
      const iconName = entry.kind === "class" ? "book" : entry.kind === "const" ? "tag" : "code";
      return `<button class="symbol-row is-${entry.kind}" type="button" data-symbol-line="${entry.line}">
        ${U.icon(iconName, "icon-xs")}
        <span class="symbol-name">${U.escapeHtml(entry.name)}</span>
        <span class="symbol-line">${entry.line}</span>
      </button>`;
    };

    const roots = entries.filter((entry) => entry.kind === "class");
    const loose = entries.filter((entry) => !ownerOf(entry) && entry.kind !== "class");

    const node = (entry) => {
      const members = entries.filter((child) => ownerOf(child) === entry.name);
      if (!members.length) return `<div class="symbol-node">${row(entry)}</div>`;
      return `<div class="symbol-node is-open">
        ${row(entry)}
        <div class="symbol-children">${members.map(row).join("")}</div>
      </div>`;
    };

    return `${roots.map(node).join("")}${loose.map(row).join("")}`;
  }

  function renderFile(path) {
    const file = fileData(path);
    if (!file) return;
    currentPath = path;

    U.qsa(".tree-file").forEach((row) => {
      const active = row.dataset.file === path;
      row.classList.toggle("is-active", active);
      if (active) row.setAttribute("aria-current", "page");
      else row.removeAttribute("aria-current");
    });

    pathCrumbs.innerHTML = pathMarkup(path);
    codePath.textContent = path;
    codeMeta.textContent = `${file.lines.length} lines · ${file.lang}`;
    codeSize.textContent = file.size;

    const targetIndex = file.comment
      ? file.lines.findIndex((line) => line.includes(file.comment.match))
      : -1;

    codeLines.innerHTML = file.lines.map((line, index) => {
      const lineNo = index + 1;
      const isTarget = index === targetIndex;
      const lineHtml = `<div class="code-line${isTarget ? " is-target" : ""}" data-line="${lineNo}">
        <span class="ln" aria-hidden="true">${lineNo}</span>
        <span class="code-text">${U.highlightPython(line) || " "}</span>
      </div>`;
      return isTarget && file.comment ? lineHtml + annotationMarkup(file.comment) : lineHtml;
    }).join("");

    symbolList.innerHTML = symbolTreeMarkup(file);
    const symbolCount = document.getElementById("symbol-count");
    if (symbolCount) symbolCount.textContent = String(file.symbols.length);

    U.qsa("[data-symbol-line]", symbolList).forEach((button) => {
      button.addEventListener("click", () => scrollToLine(Number(button.dataset.symbolLine)));
    });

    insight.innerHTML = `
      <div class="kv-row"><dt class="kv-key">Last change</dt><dd class="kv-val"><span class="mono">${file.lastCommit.sha}</span> · ${file.lastCommit.time}<br>${U.escapeHtml(file.lastCommit.message)}</dd></div>
      <div class="kv-row"><dt class="kv-key">Author</dt><dd class="kv-val">${file.lastCommit.author}</dd></div>
      <div class="kv-row"><dt class="kv-key">Used by</dt><dd class="kv-val">${file.usedBy} references</dd></div>
    `;

    document.body.dataset.crumb = `lin|atlas|${path}`;
    const crumb = document.getElementById("crumbs");
    if (crumb) {
      crumb.innerHTML = `<span>lin</span><span class="sep" aria-hidden="true">/</span><span>atlas</span><span class="sep" aria-hidden="true">/</span><span class="current" aria-current="page">${U.escapeHtml(path)}</span>`;
    }
  }

  function scrollToLine(line) {
    const target = codeLines.querySelector(`[data-line="${line}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("is-flash");
    window.setTimeout(() => target.classList.remove("is-flash"), 1600);
  }

  /* Tree ------------------------------------------------------------ */
  U.qsa(".tree-file").forEach((row) => {
    row.addEventListener("click", () => renderFile(row.dataset.file));
  });

  U.qsa("[data-folder]").forEach((folder) => {
    folder.addEventListener("click", () => {
      const collapsed = folder.classList.toggle("is-collapsed");
      folder.setAttribute("aria-expanded", String(!collapsed));
    });
  });

  treeFilter.addEventListener("input", () => {
    const query = treeFilter.value.trim().toLowerCase();
    U.qsa(".tree-file").forEach((row) => {
      row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
    });
  });

  document.querySelector("[data-find-file]").addEventListener("click", () => {
    treeFilter.focus();
    treeFilter.select();
  });

  /* Branch menu ----------------------------------------------------- */
  const branchButton = document.getElementById("branch-select");
  const branchMenu = document.getElementById("branch-menu");
  const branchLabel = document.getElementById("branch-label");

  function closeBranchMenu() {
    branchMenu.hidden = true;
    branchButton.setAttribute("aria-expanded", "false");
  }

  branchButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = branchMenu.hidden;
    branchMenu.hidden = !open;
    branchButton.setAttribute("aria-expanded", String(open));
  });

  U.qsa("[data-branch]", branchMenu).forEach((item) => {
    item.addEventListener("click", () => {
      U.qsa("[data-branch]", branchMenu).forEach((node) => node.classList.remove("is-active"));
      item.classList.add("is-active");
      branchLabel.textContent = item.dataset.branch;
      closeBranchMenu();
      window.Kustos.toast(`Viewing ${item.dataset.branch}.`, { tone: "good" });
    });
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".branch-wrap")) closeBranchMenu();
  });

  /* Raw copy -------------------------------------------------------- */
  document.querySelector("[data-code-raw]").addEventListener("click", () => {
    const file = fileData(currentPath);
    window.Kustos.copy(file.lines.join("\n"), "Raw file copied");
  });

  /* Agent rail ------------------------------------------------------ */
  const agentForm = document.querySelector("[data-file-agent-form]");
  const agentPrompt = document.getElementById("file-agent-prompt");

  agentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = agentPrompt.value.trim();
    if (!prompt) {
      agentPrompt.focus();
      return;
    }
    window.Kustos.openRunModal(`${prompt}\n\nFile: ${currentPath} (branch main)`);
  });

  U.qsa("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      window.Kustos.openRunModal(`${button.dataset.prompt}\n\nFile: ${currentPath} (branch main)`);
    });
  });

  /* Initial render -------------------------------------------------- */
  renderFile(currentPath);

  console.assert(Boolean(fileData("app/services/lfs.py")), "Code: lfs.py data is present");
  console.assert(
    fileData("app/services/lfs.py").lines.some((line) => line.includes("if scope.action not in")),
    "Code: annotated line exists"
  );
})();
