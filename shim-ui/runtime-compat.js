import { join, dirname } from 'node:path';

// Private persistence APIs: permit only releases checked by integration tests.
export const VERIFIED_VERSIONS = Object.freeze(['0.12.6', '0.12.8']);
export function runtimeRoot(version, workspaceDir) {
  if (!VERIFIED_VERSIONS.includes(version))
    throw new Error(`shim-ui: unverified Vellum version ${version}; verified: ${VERIFIED_VERSIONS.join(', ')}`);
  return join(dirname(workspaceDir), 'runtime', version, 'node_modules/@vellumai/assistant/src');
}
