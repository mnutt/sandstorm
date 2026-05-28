let currentTlsKeysCallback = null;

export function getCurrentTlsKeysCallback() {
  return currentTlsKeysCallback;
}

export function setCurrentTlsKeysCallback(callback) {
  currentTlsKeysCallback = callback;
}
