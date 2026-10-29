/* Room chat, agent mentions and live document */
(function () {
  "use strict";

  const U = window.KustosUtil;
  const messages = document.getElementById("messages");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const typing = document.getElementById("typing");
  const follow = document.getElementById("follow-btn");
  const saveDoc = document.getElementById("save-doc");
  const docState = document.getElementById("doc-state");

  function scrollToBottom() {
    window.requestAnimationFrame(() => {
      messages.scrollTop = messages.scrollHeight;
    });
  }

  function bodyMarkup(text) {
    return U.escapeHtml(text)
      .replace(/@kustos-agent/gi, '<span class="mention">$&</span>')
      .replace(/\n/g, "<br>");
  }

  function appendMessage(options) {
    const article = document.createElement("article");
    const classes = ["message"];
    if (options.me) classes.push("is-me");
    if (options.bot) classes.push("is-bot");
    article.className = classes.join(" ");
    article.innerHTML = `
      ${options.bot
        ? `<span class="avatar avatar-sm is-bot" aria-hidden="true">${U.icon("agent", "icon-xs")}</span>`
        : `<span class="avatar avatar-sm is-${options.color}" aria-hidden="true">${U.escapeHtml(options.initials)}</span>`}
      <div class="message-main">
        <div class="message-head">
          <strong>${U.escapeHtml(options.author)}</strong>
          ${options.me ? '<span class="badge is-outline">you</span>' : ""}
          ${options.bot ? '<span class="badge is-warn">bot</span>' : ""}
          <time>${U.escapeHtml(options.time)}</time>
        </div>
        <div class="message-body">${options.html || `<p>${bodyMarkup(options.text)}</p>`}</div>
      </div>
    `;
    messages.insertBefore(article, typing);
    scrollToBottom();
    return article;
  }

  function resetComposer() {
    input.value = "";
    input.style.height = "auto";
  }

  function send() {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }

    appendMessage({
      author: "Lin Wei",
      initials: "LW",
      color: "amber",
      time: U.timeNow(),
      text,
      me: true
    });
    resetComposer();
    typing.hidden = true;

    if (/@kustos-agent/i.test(text)) {
      window.setTimeout(() => {
        appendMessage({
          author: "kustos-agent",
          bot: true,
          time: U.timeNow(),
          html: `<p>Mention received. I can take that as a read-only run — open the <a href="agent.html">agent console</a> to start it, and I will post the review back here.</p><div class="message-actions"><a class="btn btn-ghost btn-sm" href="agent.html">Open agent</a></div>`
        });
        window.Kustos.toast("Kustos picked up the mention as a read-only run.", { tone: "good", title: "Agent mentioned" });
      }, 900);
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });

  follow.addEventListener("click", () => {
    const on = follow.getAttribute("aria-pressed") !== "true";
    follow.setAttribute("aria-pressed", String(on));
    follow.textContent = on ? "Following Mara" : "Follow Mara";
    window.Kustos.toast(
      on ? "Viewport is following Mara's cursor." : "Stopped following Mara.",
      { tone: on ? "good" : "info" }
    );
  });

  saveDoc.addEventListener("click", () => {
    docState.className = "badge is-good";
    docState.textContent = "synced";
    saveDoc.disabled = true;
    saveDoc.innerHTML = `${U.icon("check")}Saved`;
    const note = document.querySelector(".live-doc-actions .fine");
    if (note) note.textContent = "Commit 3b9f2c1 · index updated.";
    window.Kustos.toast("Draft saved as commit 3b9f2c1 and the index was updated.", {
      tone: "good",
      title: "Saved to branch"
    });
  });

  const roomSearch = document.querySelector(".channels-search .input");
  roomSearch.addEventListener("input", () => {
    const query = roomSearch.value.trim().toLowerCase();
    U.qsa(".channel-item").forEach((item) => {
      item.hidden = Boolean(query) && !item.textContent.toLowerCase().includes(query);
    });
  });

  scrollToBottom();
  window.addEventListener("load", scrollToBottom);

  console.assert(U.qsa(".message").length >= 6, "Chat: demo messages loaded");
  console.assert(Boolean(document.getElementById("bot-review")), "Chat: agent message present");
})();
