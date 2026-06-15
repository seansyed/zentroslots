/**
 * Runtime polyfills for JS-engine gaps. Imported FIRST in app/_layout.tsx so
 * they install before any navigation / dependency code runs.
 *
 * Why this exists (root cause of the Android release "Z" splash + ANR):
 *   The release APK runs Hermes (hermes-2024-11-12-RNv0.76.2). That engine
 *   does not implement some ES2023 Array methods that our dependencies CALL
 *   at runtime — most importantly `Array.prototype.findLast` /
 *   `findLastIndex`, used by @react-navigation/routers (StackRouter,
 *   TabRouter) inside getStateForAction / getInitialState. The first
 *   navigation action (e.g. `router.replace` from the auth gate) reaches that
 *   code; with the method undefined it throws "TypeError: undefined is not a
 *   function". That throw happens inside a React passive effect, so the
 *   ErrorBoundary catches it by UNMOUNTING the tree — which cancels the
 *   splash-dismiss timer and freezes the app on the native launch splash
 *   (observed on device as the frozen "Z" + an ANR).
 *
 *   TypeScript's lib declares these methods, so the gap is invisible to
 *   `tsc`, `expo-doctor`, and `expo export` — it only manifests at runtime
 *   under Hermes. (Dev/Expo Go masked it; this was the first real release.)
 *
 * Each polyfill is FEATURE-DETECTED: it is a no-op when the engine already
 * provides the method (a newer Hermes, or web/V8), so this file is safe to
 * ship on every platform and engine.
 *
 * The implementations are exported so they can be unit-tested directly under
 * Node (whose V8 provides the natives, so installation itself is a no-op
 * there).
 */

/* eslint-disable no-extend-native, @typescript-eslint/no-explicit-any, func-names */

type Predicate<T> = (value: T, index: number, array: T[]) => unknown;

/** Spec-faithful `Array.prototype.findLast` body (iterates high → low index). */
export function findLastImpl<T>(arr: T[], predicate: Predicate<T>, thisArg?: unknown): T | undefined {
  if (arr == null) throw new TypeError("Array.prototype.findLast called on null or undefined");
  if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
  const o = Object(arr) as T[];
  const len = o.length >>> 0;
  for (let i = len - 1; i >= 0; i--) {
    const value = o[i];
    if (predicate.call(thisArg, value, i, o)) return value;
  }
  return undefined;
}

/** Spec-faithful `Array.prototype.findLastIndex` body (iterates high → low). */
export function findLastIndexImpl<T>(arr: T[], predicate: Predicate<T>, thisArg?: unknown): number {
  if (arr == null) throw new TypeError("Array.prototype.findLastIndex called on null or undefined");
  if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
  const o = Object(arr) as T[];
  const len = o.length >>> 0;
  for (let i = len - 1; i >= 0; i--) {
    if (predicate.call(thisArg, o[i], i, o)) return i;
  }
  return -1;
}

/** Spec-faithful `Array.prototype.at` body (supports negative indices). */
export function atImpl<T>(arr: T[], index: number): T | undefined {
  const o = Object(arr) as T[];
  const len = o.length >>> 0;
  let i = Math.trunc(Number(index)) || 0;
  if (i < 0) i += len;
  if (i < 0 || i >= len) return undefined;
  return o[i];
}

function define(name: string, value: (...args: any[]) => unknown): void {
  Object.defineProperty(Array.prototype, name, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/** Install missing array methods. Returns the list of names actually added. */
export function installArrayPolyfills(): string[] {
  const added: string[] = [];
  const proto = Array.prototype as any;

  if (typeof proto.findLast !== "function") {
    define("findLast", function (this: any[], p: Predicate<any>, t?: unknown) {
      return findLastImpl(this, p, t);
    });
    added.push("findLast");
  }
  if (typeof proto.findLastIndex !== "function") {
    define("findLastIndex", function (this: any[], p: Predicate<any>, t?: unknown) {
      return findLastIndexImpl(this, p, t);
    });
    added.push("findLastIndex");
  }
  if (typeof proto.at !== "function") {
    define("at", function (this: any[], i: number) {
      return atImpl(this, i);
    });
    added.push("at");
  }
  return added;
}

// Install on import. Safe + idempotent: no-op when the engine already has them.
installArrayPolyfills();

export {};
