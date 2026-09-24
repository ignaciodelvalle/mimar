// `babel-preset-expo` is what turns TypeScript and JSX into something Metro
// (and Jest, through `jest-expo`) can run. It is listed explicitly rather than
// left to Metro's default because Jest reads THIS file — without it the pure
// mapping test would fail on the first `import type`.
module.exports = (api) => {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
