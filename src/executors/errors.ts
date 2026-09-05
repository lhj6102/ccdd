export function diagnosticError(code: string, message: string, remedy: string) {
  return Object.assign(new Error(message), { code, remedy });
}
export function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
export function errorCode(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string') return value.code;
  return undefined;
}
