// Jest auto-mock for the native TFLite module. Unit tests exercise pure helpers
// (preprocessRgb, l2Normalize, scoring) and never run real inference, so a
// minimal stub of loadTensorflowModel is enough to let engine.ts import.
const makeModel = () => ({
  inputs: [{shape: [1, 112, 112, 3]}],
  outputs: [{shape: [1, 192]}],
  run: async () => [new Float32Array(192)],
});

module.exports = {
  loadTensorflowModel: jest.fn(async () => makeModel()),
};
