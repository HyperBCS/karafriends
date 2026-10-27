/** @type {import("lint-staged").Configuration} */
export default {
  "**/*": "prettier --write --ignore-unknown",
  "**/*.{ts,tsx}": "oxlint --deny-warnings",
  "**/*.rs": [
    "rustfmt",
    // Clippy checks the whole crate, so the function form keeps lint-staged
    // from appending the staged filenames. It only runs when Rust changes.
    () => "cargo clippy --manifest-path native/Cargo.toml",
  ],
};
