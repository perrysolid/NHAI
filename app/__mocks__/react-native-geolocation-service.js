// Jest mock for react-native-geolocation-service. Tests never touch real GPS;
// CameraScreen wires a StubLocationProvider under test.
module.exports = {
  __esModule: true,
  default: {
    requestAuthorization: jest.fn(() => Promise.resolve('granted')),
    getCurrentPosition: jest.fn(success => {
      success({
        coords: {latitude: 0, longitude: 0, accuracy: 10},
        mocked: false,
        timestamp: 0,
      });
    }),
    watchPosition: jest.fn(() => 0),
    clearWatch: jest.fn(),
    stopObserving: jest.fn(),
  },
};
