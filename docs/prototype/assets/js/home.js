/* Watch page interactions */
(function () {
  "use strict";

  const U = window.KustosUtil;
  const date = document.querySelector("[data-date]");
  const clock = document.querySelector("[data-clock]");
  const greeting = document.querySelector("[data-greeting]");
  const form = document.querySelector("[data-ask-form]");
  const input = document.getElementById("ask-input");

  if (date) date.textContent = U.dateLine();
  if (greeting) greeting.textContent = U.greeting();
  if (clock) clock.textContent = U.timeNow();

  if (form && input) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const prompt = input.value.trim();
      if (!prompt) {
        input.focus();
        return;
      }
      window.Kustos.openRunModal(prompt);
    });

    U.qsa("[data-prompt]").forEach((button) => {
      button.addEventListener("click", () => {
        input.value = button.dataset.prompt;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    });
  }

  console.assert(
    U.qsa(".review-row").length === 3,
    "Watch: expected three review rows"
  );
  console.assert(
    typeof window.Kustos === "object",
    "Watch: shell API is available"
  );
})();
