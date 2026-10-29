/* Small shared helpers: escaping, a conservative Python highlighter, copy, time. */
window.KustosUtil = (function () {
  "use strict";

  const PY_KEYWORDS = new Set([
    "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "False", "finally", "for", "from",
    "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not",
    "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"
  ]);

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function span(kind, text) {
    return `<span class="tok-${kind}">${escapeHtml(text)}</span>`;
  }

  function highlightPython(source) {
    let out = "";
    let i = 0;
    const n = source.length;

    while (i < n) {
      const ch = source[i];

      if (ch === "#") {
        let end = source.indexOf("\n", i);
        if (end < 0) end = n;
        out += span("comment", source.slice(i, end));
        i = end;
        continue;
      }

      if (ch === '"' || ch === "'") {
        const triple = source.slice(i, i + 3);
        if (triple === '"""' || triple === "'''") {
          let end = source.indexOf(triple, i + 3);
          end = end < 0 ? n : end + 3;
          out += span("str", source.slice(i, end));
          i = end;
          continue;
        }
        let j = i + 1;
        while (j < n && source[j] !== ch) {
          j += source[j] === "\\" ? 2 : 1;
        }
        j = Math.min(j + 1, n);
        out += span("str", source.slice(i, j));
        i = j;
        continue;
      }

      if (ch === "@") {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_.]/.test(source[j])) j += 1;
        out += span("deco", source.slice(i, j));
        i = j;
        continue;
      }

      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(source[j])) j += 1;
        const word = source.slice(i, j);
        if (PY_KEYWORDS.has(word)) {
          out += span("kw", word);
        } else if (word === "self" || word === "cls") {
          out += span("self", word);
        } else {
          let k = j;
          while (k < n && /\s/.test(source[k])) k += 1;
          if (source[k] === "(") out += span("fn", word);
          else if (/^[A-Z]/.test(word)) out += span("cls", word);
          else out += escapeHtml(word);
        }
        i = j;
        continue;
      }

      if (/[0-9]/.test(ch)) {
        let j = i + 1;
        while (j < n && /[0-9_.a-fA-FxX]/.test(source[j])) j += 1;
        out += span("num", source.slice(i, j));
        i = j;
        continue;
      }

      out += escapeHtml(ch);
      i += 1;
    }

    return out;
  }

  function highlightMarkdown(source) {
    return source.split("\n").map((line) => {
      if (/^#{1,3}\s/.test(line)) return `<span class="tok-head">${escapeHtml(line)}</span>`;
      if (/^```/.test(line)) return `<span class="tok-comment">${escapeHtml(line)}</span>`;
      if (/^[-*]\s/.test(line)) return `<span class="tok-fn">${escapeHtml(line.slice(0, 2))}</span>${escapeHtml(line.slice(2))}`;
      return escapeHtml(line);
    }).join("\n");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (copyError) {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  function timeNow() {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date());
  }

  function dateLine() {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long"
    }).format(new Date());
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 5) return "Still up";
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }

  function debounce(fn, wait) {
    let timer = 0;
    return function debounced() {
      window.clearTimeout(timer);
      const args = arguments;
      timer = window.setTimeout(() => fn.apply(null, args), wait);
    };
  }

  function icon(name, className) {
    return `<svg class="icon ${className || ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  return {
    escapeHtml,
    highlightPython,
    highlightMarkdown,
    copyText,
    timeNow,
    dateLine,
    greeting,
    debounce,
    icon,
    qs,
    qsa
  };
})();
