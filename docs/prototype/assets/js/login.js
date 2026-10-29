/* Sign in interactions */
(function () {
  "use strict";

  const U = window.KustosUtil;
  const form = document.getElementById("login-form");
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const error = document.getElementById("login-error");
  const submit = document.getElementById("login-submit");
  const toggle = document.getElementById("password-toggle");
  const toastStack = document.getElementById("toasts");

  function toast(message) {
    const node = document.createElement("div");
    node.className = "toast";
    node.innerHTML = `
      ${U.icon("spark")}
      <div class="toast-copy"><span>${U.escapeHtml(message)}</span></div>
      <button class="toast-close" type="button" aria-label="Dismiss">${U.icon("x", "icon-xs")}</button>
    `;
    toastStack.appendChild(node);
    const remove = () => {
      node.style.opacity = "0";
      node.style.transform = "translateY(6px)";
      window.setTimeout(() => node.remove(), 160);
    };
    node.querySelector(".toast-close").addEventListener("click", remove);
    window.setTimeout(remove, 4200);
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-toast]");
    if (!trigger) return;
    event.preventDefault();
    toast(trigger.dataset.toast);
  });

  toggle.addEventListener("click", () => {
    const visible = password.type === "text";
    password.type = visible ? "password" : "text";
    toggle.classList.toggle("is-visible", !visible);
    toggle.setAttribute("aria-pressed", String(!visible));
    toggle.setAttribute("aria-label", visible ? "Show password" : "Hide password");
    password.focus();
  });

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  [email, password].forEach((input) => {
    input.addEventListener("input", () => {
      error.hidden = true;
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const emailValue = email.value.trim();
    const passwordValue = password.value;

    if (!emailValue || !emailValue.includes("@")) {
      showError("Enter a valid email address.");
      email.focus();
      return;
    }

    if (!passwordValue) {
      showError("Enter your password to continue.");
      password.focus();
      return;
    }

    error.hidden = true;
    submit.classList.add("is-loading");
    submit.setAttribute("aria-busy", "true");
    submit.innerHTML = `${U.icon("loader")}<span>Signing in…</span>`;

    window.setTimeout(() => {
      window.location.href = "index.html";
    }, 650);
  });

  console.assert(document.getElementById("i-agent"), "Login: icon sprite mounted");
})();
