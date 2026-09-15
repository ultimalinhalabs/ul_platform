/** Express 5 types route params as `string | string[]` for wildcard matches. */
export function paramString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
