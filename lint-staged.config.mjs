/** @type {import("lint-staged").Configuration} */
export default {
  // lint-staged runs the patterns at once, so no file is in two of them that
  // both touch it: TypeScript is formatted, then linted, in order.
  "**/*.{ts,tsx}": ["prettier --write", "oxlint --deny-warnings"],
  "!(*.ts|*.tsx)": "prettier --write --ignore-unknown",
  // Prettier doesn't know .rs files, so the line above leaves them alone.
  "**/*.rs": [
    // The crates' edition, which cargo fmt reads from Cargo.toml and plain
    // rustfmt doesn't (it would parse 2015 and reject let chains).
    "rustfmt --edition 2024",
    // Clippy checks the whole crate, so the function form keeps lint-staged
    // from appending the staged filenames. It only runs when Rust changes.
    () => "cargo clippy --manifest-path native/Cargo.toml",
  ],
};
