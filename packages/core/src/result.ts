/**
 * The simplest error-branching shape: a success value or an Error instance,
 * narrowed via `instanceof` - no wrapper object `{ok, value}`, no new
 * dependency. A caller that needs to react differently per failure reason
 * checks `"kind" in result && result.kind === "..."` against a specific
 * tagged error shape (e.g. @soltrk/anker's AccountLockedError) after
 * narrowing with `Result.isErr`; a caller that doesn't care just uses
 * `Result.isErr`/`Result.isOk` directly.
 *
 * `Result` is both the type above and the identity function below - type
 * space and value space are separate in TypeScript, so the same name works
 * for both. Functions are plain objects in JS, so `Result.isErr`/
 * `Result.isOk` are just properties attached to that function after the
 * fact (TypeScript infers these automatically when assigned in the same
 * scope right after declaration) - same convention as the sibling
 * picomanager project's `core/result.ts`, and deliberately not `namespace`
 * (a legacy TS module-organization feature some lint configs flag
 * regardless of how it's used).
 */
export type Result<T, E extends Error = Error> = T | E;

export const Result = <T, E extends Error = Error>(value: Result<T, E>): Result<T, E> => value;

Result.isErr = <T, E extends Error>(result: Result<T, E>): result is E => result instanceof Error;

Result.isOk = <T, E extends Error>(result: Result<T, E>): result is T => !Result.isErr(result);
