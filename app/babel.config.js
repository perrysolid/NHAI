module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // VisionCamera frame-processor worklets run on a separate thread.
    // react-native-worklets-core's babel plugin transforms them.
    'react-native-worklets-core/plugin',
    // IMPORTANT: the reanimated plugin MUST be listed LAST.
    'react-native-reanimated/plugin',
  ],
};
