let globalBackend;

export function setGlobalBackend(backend) {
  globalBackend = backend;
}

export function getGlobalBackend() {
  if (!globalBackend) {
    throw new Error("Sandstorm backend is not initialized yet.");
  }

  return globalBackend;
}

export { globalBackend };
