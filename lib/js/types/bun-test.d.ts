// Minimal type shim for "bun:test" so the package can stay zero-dependency
// (no `bun-types` install needed). Covers exactly what our tests use.
declare module "bun:test" {
  export const test: (name: string, fn: () => void | Promise<void>) => void;
  export const describe: (name: string, fn: () => void) => void;
  export const beforeAll: (fn: () => void | Promise<void>) => void;
  export const beforeEach: (fn: () => void | Promise<void>) => void;
  export const afterAll: (fn: () => void | Promise<void>) => void;
  export const afterEach: (fn: () => void | Promise<void>) => void;
  export const expect: {
    <T>(value: T): {
      toBe: (expected: T) => void;
      toEqual: (expected: unknown) => void;
      toContain: (expected: unknown) => void;
      toBeTruthy: () => void;
      toBeFalsy: () => void;
      toBeDefined: () => void;
      toBeUndefined: () => void;
      toBeNull: () => void;
      toBeGreaterThan: (n: number) => void;
      toBeGreaterThanOrEqual: (n: number) => void;
      toBeLessThan: (n: number) => void;
      toBeLessThanOrEqual: (n: number) => void;
      toThrow: (msg?: string | RegExp) => void;
      rejects: {
        toThrow: (msg?: string | RegExp) => Promise<void>;
      };
    };
  };
}
