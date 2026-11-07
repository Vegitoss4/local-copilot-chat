import mockRequire = require('mock-require');
import { vscodeMock } from './mocks/vscodeMock';

// Register mock before any test suite loads production modules
mockRequire('vscode', vscodeMock);

const nativeFetch = global.fetch;

// Default network isolation guard for unit test environment:
// Prevents unmocked calls from attempting real TCP connections to offline services (e.g. 127.0.0.1:11434)
const defaultFastFailFetch = async (input: any) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  throw new Error(`[Unit Test Network Isolation] Offline mock fallback for: ${url}`);
};

(defaultFastFailFetch as any).__isDefaultTestMock = true;
global.fetch = defaultFastFailFetch as any;

// Export for explicit reference
export { vscodeMock, nativeFetch };
