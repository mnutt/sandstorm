import type { Failure, FailureCode } from '../generated/shell';

/** Expected application failures, distinct from transport or protocol failures. */
export class ApplicationError extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); }
}
export function unwrap<T>(result: {readonly _isValue:boolean; readonly _isFailure:boolean; readonly value:T; readonly failure:Failure}): T {
  if (result._isFailure) throw new ApplicationError(result.failure.code,result.failure.message);
  if (!result._isValue) throw new Error('The server returned an unsupported result.');
  return result.value;
}

export function applicationErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApplicationError ? error.message : fallback;
}
