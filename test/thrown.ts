/**
 * thrown and rejected return the error a callback throws (or a promise
 * rejects with), after checking it is an instance of `errorClass` and, when
 * given, that its message includes `messageIncludes`. They stand in for the
 * value-returning `assertThrows`/`assertRejects` of `@std/assert`, built on
 * `node:assert` so the same tests run on Bun and Node.
 */
import assert from "node:assert/strict";

type ErrorClass<T extends Error> = abstract new (...args: never[]) => T;

/** thrown calls `callback` and returns the Error it throws. */
export function thrown<T extends Error = Error>(
  callback: () => unknown,
  errorClass?: ErrorClass<T>,
  messageIncludes?: string,
): T {
  let caught: unknown;
  let didThrow = false;
  try {
    callback();
  } catch (error) {
    didThrow = true;
    caught = error;
  }
  assert.ok(didThrow, "Expected function to throw");
  return check(caught, errorClass, messageIncludes);
}

/** rejected awaits the promise `callback` returns and returns its rejection. */
export async function rejected<T extends Error = Error>(
  callback: () => Promise<unknown>,
  errorClass?: ErrorClass<T>,
  messageIncludes?: string,
): Promise<T> {
  let caught: unknown;
  let didReject = false;
  try {
    await callback();
  } catch (error) {
    didReject = true;
    caught = error;
  }
  assert.ok(didReject, "Expected function to reject");
  return check(caught, errorClass, messageIncludes);
}

function check<T extends Error>(
  caught: unknown,
  errorClass: ErrorClass<T> | undefined,
  messageIncludes: string | undefined,
): T {
  assert.ok(
    caught instanceof (errorClass ?? Error),
    `Expected error to be an instance of ${(errorClass ?? Error).name}`,
  );
  const error = caught as T;
  if (messageIncludes !== undefined) {
    assert.ok(
      error.message.includes(messageIncludes),
      `Expected error message to include "${messageIncludes}": ${error.message}`,
    );
  }
  return error;
}
