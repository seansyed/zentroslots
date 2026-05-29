module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // Reanimated MUST be listed last.
      "react-native-reanimated/plugin",
    ],
  };
};
