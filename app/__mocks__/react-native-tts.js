// Jest auto-mock for react-native-tts. The app's TTS layer is fire-and-forget
// and fully guarded, so noop async methods are a faithful stand-in.
module.exports = {
  getInitStatus: jest.fn().mockResolvedValue('success'),
  setDefaultRate: jest.fn().mockResolvedValue(undefined),
  setDefaultPitch: jest.fn().mockResolvedValue(undefined),
  setDefaultLanguage: jest.fn().mockResolvedValue(undefined),
  requestInstallEngine: jest.fn().mockResolvedValue(undefined),
  speak: jest.fn(),
  stop: jest.fn(),
};
