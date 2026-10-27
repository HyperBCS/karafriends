import "./toast.css";

const SHOW_MS = 4000;
// How long toast-out in toast.css takes.
const LEAVE_MS = 375;

// Shows text in the display's top right corner for a few seconds, as a
// heading or as plain text. The text goes in as text, never as markup, so
// song titles and nicknames from the phones can't inject anything.
export default function toast(
  text: string,
  { heading = false }: { heading?: boolean } = {},
) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }

  const element = document.createElement("div");
  element.className = "toast";
  if (heading) {
    element.appendChild(document.createElement("h3")).textContent = text;
  } else {
    element.textContent = text;
  }
  container.appendChild(element);

  setTimeout(() => {
    element.classList.add("toast-leaving");
    setTimeout(() => element.remove(), LEAVE_MS);
  }, SHOW_MS);
}
