/**
 * Shared test mocks — import from here instead of defining inline.
 *
 * @example
 * import { MockSession, MockStateStore, terminalOutputs } from './mocks/index.js';
 */

export { MockSession, createMockSession, terminalOutputs } from './mock-session.js';
export { MockStateStore } from './mock-state-store.js';
export {
  waitForEvent,
  createDeferred,
  safeRmHomeTree,
  isUnderTestHome,
  isSandboxedHome,
  assertSandboxedHome,
  TEST_HOME_PREFIX,
} from './test-helpers.js';
export { createMockRouteContext, type MockRouteContext } from './mock-route-context.js';
