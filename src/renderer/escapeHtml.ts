// For text from the phones (song titles, nicknames) going into HTML, such as
// an M.toast: as markup it could run script in the display.
export default function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
