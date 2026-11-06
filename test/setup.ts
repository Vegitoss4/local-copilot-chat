import mockRequire = require('mock-require');
import { vscodeMock } from './mocks/vscodeMock';

// Register mock before any test suite loads production modules
mockRequire('vscode', vscodeMock);

// Export for explicit reference
export { vscodeMock };
