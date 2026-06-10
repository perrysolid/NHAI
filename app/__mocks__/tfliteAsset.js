// Jest stub for require()'d *.tflite model binaries. In the app these resolve
// to a numeric asset id via Metro; the binary itself is never parsed by JS, so
// a number is a faithful stand-in for unit tests.
module.exports = 1;
