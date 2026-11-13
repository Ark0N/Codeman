/**
 * Shared test mocks — import from here instead of defining inline.
 *
 * @example
 * import { MockSession, createMockRouteContext } from './mocks/index.js';
 */

export { MockSession, createMockSession } from './mock-session.js';
export {
  safeRmHomeTree,
  isUnderTestHome,
  isSandboxedHome,
  assertSandboxedHome,
  TEST_HOME_PREFIX,
} from './test-helpers.js';
export { createMockRouteContext, type MockRouteContext } from './mock-route-context.js';
