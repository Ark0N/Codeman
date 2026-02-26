# Codeman TypeScript Improvement Suggestions

**Generated**: February 2026
**Based on**: Research into TypeScript best practices (2024-2025) and codebase analysis

---

## 🔴 High Priority (Low effort, high impact)

### 1. Use the Already-Installed Zod for API Validation

Zod v4.3.6 is in `package.json` but **never imported**. API routes use unsafe type assertions:

```typescript
// Current (unsafe)
const body = req.body as CreateSessionRequest;

// Recommended
const result = CreateSessionSchema.safeParse(req.body);
if (!result.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, ...);
```

**Impact**: Prevents runtime errors from malformed client requests.

**Files to update**: `src/web/server.ts` (all POST/PUT routes)

---

### 2. Add `assertNever` for Exhaustive Switch Checking

Switch statements on union types (e.g., `respawn-controller.ts:1072`, `ralph-tracker.ts:2088`) lack exhaustive checking. Adding new union members won't cause compile errors.

```typescript
// Add to src/utils/type-safety.ts
export function assertNever(x: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${JSON.stringify(x)}`);
}

// Usage in switch statements
switch (status) {
  case 'idle': return handleIdle();
  case 'busy': return handleBusy();
  case 'stopped': return handleStopped();
  case 'error': return handleError();
  default: return assertNever(status);
}
```

**Impact**: Compile-time guarantee all cases are handled.

**Files affected**: `respawn-controller.ts`, `ralph-tracker.ts`, any file with switch on union types

---

### 3. Standardize `createErrorResponse` Usage

Currently only used in 2 files despite being a good pattern. Many routes still use ad-hoc error responses.

**Impact**: Consistent API error format across all endpoints.

---

## 🟡 Medium Priority (Medium effort, significant benefit)

### 4. Convert `ApiResponse<T>` to Discriminated Union

Current interface has optional properties; discriminated union enables better narrowing:

```typescript
// Current (types.ts)
interface ApiResponse<T> { success: boolean; error?: string; data?: T; }

// Better
type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; errorCode: ApiErrorCode };

// Usage with exhaustive checking
function handleResponse<T>(response: ApiResponse<T>): T {
  if (response.success) {
    return response.data; // TypeScript knows data exists
  } else {
    throw new Error(response.error); // TypeScript knows error exists
  }
}
```

---

### 5. Add Branded Types for Token Counts

Prevents mixing input/output tokens in calculations:

```typescript
// src/types/branded.ts
type Brand<K, T extends string> = K & { readonly __brand: T };

export type InputTokens = Brand<number, 'InputTokens'>;
export type OutputTokens = Brand<number, 'OutputTokens'>;
export type TokenCount = Brand<number, 'TokenCount'>;
export type Milliseconds = Brand<number, 'Milliseconds'>;

// Constructor functions
export function inputTokens(value: number): InputTokens {
  if (value < 0) throw new Error('Token count cannot be negative');
  return value as InputTokens;
}
```

**Use cases**:
- Token counts (`_totalInputTokens`, `_totalOutputTokens`)
- Timeout values (`idleTimeoutMs`, `completionConfirmMs`, `noOutputTimeoutMs`)
- IDs (`SessionId`, `TaskId`, `CycleId`)

---

### 6. Dependency Injection for Core Services

Replace hidden singleton dependencies with constructor injection for better testability:

```typescript
// Current: Hidden dependencies
export class RalphLoop extends EventEmitter {
  constructor() {
    this.sessionManager = getSessionManager();
    this.store = getStore();
  }
}

// Better: Explicit dependencies
export interface RalphLoopDeps {
  sessionManager: SessionManager;
  taskQueue: TaskQueue;
  store: StateStore;
}

export class RalphLoop extends EventEmitter {
  constructor(deps: RalphLoopDeps, options?: RalphLoopOptions) {
    this.sessionManager = deps.sessionManager;
    // ...
  }
}

// Production factory
export function createRalphLoop(options?: RalphLoopOptions): RalphLoop {
  return new RalphLoop({
    sessionManager: getSessionManager(),
    taskQueue: getTaskQueue(),
    store: getStore(),
  }, options);
}
```

**Start with**: `RalphLoop` (has the most dependencies)

**Benefits**: Easier testing, explicit dependencies, SOLID compliance

---

### 7. Enforce Consistent `import type` Usage

Mixed usage across codebase. Add ESLint rule:

```json
{
  "rules": {
    "@typescript-eslint/consistent-type-imports": ["error", {
      "prefer": "type-imports",
      "fixStyle": "separate-type-imports"
    }]
  }
}
```

**Benefits**: Reduced bundle size, better tree-shaking, cleaner separation

---

### 8. Add Circular Dependency Detection

```bash
npm install -D dpdm
```

Add to `package.json`:
```json
{
  "scripts": {
    "check:circular": "dpdm --no-warning --no-tree src/index.ts"
  }
}
```

**Potential risk areas identified**:
- `ralph-loop.ts` → `session-manager.ts` → `session.ts`
- `respawn-controller.ts` → `session.ts` → `ai-idle-checker.ts`

---

## 🟢 Lower Priority (Higher effort, situational benefit)

### 9. Apply `as const satisfies` to Default Configs

Preserves literal types while validating structure:

```typescript
// Current
export const DEFAULT_NICE_CONFIG: NiceConfig = {
  enabled: false,
  niceValue: 10,
};
// niceValue is type: number

// Better
export const DEFAULT_NICE_CONFIG = {
  enabled: false,
  niceValue: 10,
} as const satisfies NiceConfig;
// niceValue is type: 10 (literal)
```

**Files**: `types.ts`, `respawn-controller.ts` (DEFAULT_CONFIG)

---

### 10. Create Custom Error Class Hierarchy

Replace string-based errors with typed errors:

```typescript
// src/errors.ts
export class CodemanError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    Object.setPrototypeOf(this, CodemanError.prototype);
    this.name = 'CodemanError';
  }
}

export class SessionError extends CodemanError {
  constructor(message: string, code: string, public sessionId: string) {
    super(message, code, { sessionId });
    this.name = 'SessionError';
  }
}

export class ValidationError extends CodemanError {
  constructor(message: string, public field: string, public value: unknown) {
    super(message, 'VALIDATION_ERROR', { field, value });
    this.name = 'ValidationError';
  }
}

export class ScreenError extends CodemanError {
  constructor(message: string, public screenName: string, public operation: string) {
    super(message, 'SCREEN_ERROR', { screenName, operation });
    this.name = 'ScreenError';
  }
}
```

---

### 11. Split Large Files

**`types.ts` (~1500 lines)**:
```
src/types/
  index.ts            # Re-exports all
  session.types.ts    # Session-related types
  task.types.ts       # Task-related types
  ralph.types.ts      # Ralph loop types
  api.types.ts        # API request/response types
  config.types.ts     # Configuration types
  factories.ts        # createInitialState(), etc.
```

**`server.ts`**:
```
src/web/
  server.ts           # Main Fastify setup
  routes/
    sessions.ts       # Session management routes
    respawn.ts        # Respawn control routes
    scheduled.ts      # Scheduled run routes
    system.ts         # System status routes
  sse/
    manager.ts        # SSE client management
```

---

### 12. Formalize Result Pattern

Existing `validateTokenCounts` returns `{ isValid, reason }` which is essentially a Result.

**Option A: Simple Result type (no dependency)**:
```typescript
// src/utils/result.ts
export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

export const ok = <T>(data: T): Result<T, never> => ({ success: true, data });
export const err = <E>(error: E): Result<never, E> => ({ success: false, error });
```

**Option B: Install neverthrow**:
```bash
npm install neverthrow
```

Provides chaining (`map`, `andThen`, `match`) and `ResultAsync` for async operations.

---

### 13. Template Literal Types for IDs

Enforce ID formats at compile time:

```typescript
type CycleIdFormat = `${string}:cycle-${number}`;
type ScreenSessionName = `codeman-${string}`;

interface RespawnCycleMetrics {
  cycleId: CycleIdFormat; // Enforces format at compile time
}
```

---

## Summary Table

| # | Suggestion | Category | Effort | Impact |
|---|------------|----------|--------|--------|
| 1 | Use Zod for API validation | Error Handling | Low | High |
| 2 | Add `assertNever` utility | Type Safety | Low | High |
| 3 | Standardize `createErrorResponse` | Error Handling | Low | Medium |
| 4 | Discriminated union for `ApiResponse` | Type Safety | Medium | High |
| 5 | Branded types for tokens | Type Safety | Medium | Medium |
| 6 | Dependency injection for services | Architecture | Medium | High |
| 7 | Enforce `import type` | Architecture | Low | Medium |
| 8 | Circular dependency detection | Architecture | Low | Medium |
| 9 | `as const satisfies` for configs | Type Safety | Low | Low |
| 10 | Custom error classes | Error Handling | Medium | Medium |
| 11 | Split large files | Architecture | High | Medium |
| 12 | Formalize Result pattern | Error Handling | Medium | Medium |
| 13 | Template literal types for IDs | Type Safety | Low | Low |

---

## Notable Strengths to Keep

These patterns are already well-implemented and should be preserved:

- **Circuit breaker pattern** in `state-store.ts` and `ai-checker-base.ts` (excellent resilience)
- **`getErrorMessage()` utility** (solid, used in 8 files)
- **Barrel files for `utils/` and `prompts/`** (appropriate size, good organization)
- **Strict TypeScript config** (comprehensive strictness settings)
- **Well-documented configuration** in `src/config/`
- **Extensive union types** for status tracking (18+ well-defined types)
- **Type guards** like `isError()` for runtime narrowing

---

## References

### Type Safety
- [TypeScript Handbook: Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [Fullstory: Discriminated Unions](https://www.fullstory.com/blog/discriminated-unions-and-exhaustiveness-checking-in-typescript/)
- [Learning TypeScript: Branded Types](https://www.learningtypescript.com/articles/branded-types)
- [Total TypeScript: satisfies Operator](https://www.totaltypescript.com/how-to-use-satisfies-operator)

### Error Handling
- [neverthrow GitHub](https://github.com/supermacro/neverthrow)
- [Zod Documentation](https://zod.dev/)
- [Custom Errors in TypeScript](https://medium.com/@Nelsonalfonso/understanding-custom-errors-in-typescript-a-complete-guide-f47a1df9354c)

### Architecture
- [Please Stop Using Barrel Files - TkDodo](https://tkdodo.eu/blog/please-stop-using-barrel-files)
- [TypeScript Dependency Injection](https://softwarepatternslexicon.com/js/typescript-and-javascript-design-patterns/dependency-injection-with-typescript/)
- [dpdm - Circular Dependency Detector](https://github.com/acrazing/dpdm)
- [Consistent Type Imports - typescript-eslint](https://typescript-eslint.io/blog/consistent-type-imports-and-exports-why-and-how/)
