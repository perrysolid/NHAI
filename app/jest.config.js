module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    // Model binaries are require()'d as Metro assets; stub them for unit tests.
    '\\.tflite$': '<rootDir>/__mocks__/tfliteAsset.js',
    // Static image assets (logo/branding) require()'d as Metro assets.
    '\\.(png|jpg|jpeg|gif|webp|svg)$': '<rootDir>/__mocks__/fileMock.js',
  },
};
