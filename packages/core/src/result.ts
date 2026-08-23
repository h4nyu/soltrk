/**
 * The simplest error-branching shape: a success value or an Error instance,
 * narrowed via `instanceof` - no wrapper object `{ok, value}`, no new
 * dependency. A caller that needs to react differently per failure reason
 * checks `instanceof` against a specific Error subclass (e.g.
 * @soltrk/anker's AccountLockedError) before falling back to the generic
 * Error case; a caller that doesn't care just checks `instanceof Error`.
 */
export type Result<T, E extends Error = Error> = T | E;
