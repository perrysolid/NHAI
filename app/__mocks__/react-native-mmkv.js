// Jest auto-mock for react-native-mmkv: an in-memory store matching the subset
// of the MMKV API the OfflineAuthStore uses (getString/set/delete).
class MMKV {
  constructor() {
    this._map = new Map();
  }
  getString(key) {
    return this._map.get(key);
  }
  set(key, value) {
    this._map.set(key, value);
  }
  delete(key) {
    this._map.delete(key);
  }
}

module.exports = {MMKV};
