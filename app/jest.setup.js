// Disable real network in unit tests. Node 20+/24 ships a global fetch, and the
// app now has a live SYNC.url baked in — without this, tests that touch the
// enroll/sync path would POST junk to the real backend. Code that needs the
// network in a test injects its own `fetchImpl` (see sync/enrollment clients).
global.fetch = jest.fn(() =>
  Promise.reject(new Error('network disabled in unit tests')),
);

// NetInfo's native module isn't present under Jest — use the library's own mock
// (defaults to isConnected: true).
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock.js'),
);
