module.exports = function (api) {
  api.cache(true);
  return {
    // babel-preset-expo (SDK 54+) automatically appends
    // react-native-worklets/plugin (used by react-native-reanimated v4)
    // last when the package is installed. Do NOT also add it manually
    // here — applying the worklets/reanimated Babel plugin twice breaks
    // worklet transforms.
    presets: ["babel-preset-expo"],
  };
};
