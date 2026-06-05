import {MMKV} from 'react-native-mmkv';
import {OfflineAuthStore} from './offlineStore';

export function createEncryptedAuthStore(): OfflineAuthStore {
  const storage = new MMKV({
    id: 'datalake-face-auth',
    encryptionKey: 'replace-with-device-keychain-secret',
  });
  return new OfflineAuthStore(storage);
}
