# karafriends

<img src="https://raw.githubusercontent.com/emmaworley/karafriends/master/icon.png" width="128" />

## Building

Dependencies

- Node.js, plus any `yarn` on your PATH (`npm install -g yarn` is enough). The repo pins its Yarn version in `.yarn/releases` via `yarnPath`, so whichever `yarn` you run hands off to it; corepack isn't needed.
- Rust

## Running

```sh
yarn install && yarn run-dev
```

`yarn install` puts dependencies in `node_modules` and keeps its download cache in `.yarn/cache`. Neither is committed.
