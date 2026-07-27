// Jest auto-mock for the native TFLite module.
//
// Pure helpers (preprocessRgb, l2Normalize, scoring) don't run inference, but
// the CameraScreen integration test DOES: it needs a deterministic model whose
// output makes a self-match pass both recognition and liveness. We return one
// fixed 192-length vector (mobilefacenet embeddingLength) with a dominant value
// at index 1 so the liveness softmax(live=index 1) lands ~0.99, while any two
// embeddings from it are identical => cosine 1.0 for recognition.
function fixedOutput() {
  const out = new Float32Array(512).fill(0.1);
  out[1] = 10; // dominant "live" logit + a stable embedding direction
  return out;
}

const makeModel = () => ({
  inputs: [{shape: [1, 112, 112, 3]}],
  outputs: [{shape: [1, 512]}],
  run: async () => [fixedOutput()],
});

module.exports = {
  loadTensorflowModel: jest.fn(async () => makeModel()),
};
