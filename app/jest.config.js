module.exports = {
  preset: 'react-native',
  moduleNameMapper: {
    // Model binaries are require()'d as Metro assets; stub them for unit tests.
    '\\.tflite$': '<rootDir>/__mocks__/tfliteAsset.js',
  },
};
