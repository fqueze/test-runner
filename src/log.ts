function timestamp(): string {
  return new Date().toISOString();
}

export function log(...args: unknown[]): void {
  console.log(timestamp(), ...args);
}

export function logError(...args: unknown[]): void {
  console.error(timestamp(), ...args);
}
