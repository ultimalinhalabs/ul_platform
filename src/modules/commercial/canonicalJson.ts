import { createHash } from "node:crypto";

/**
 * Block 1B — canonical JSON for commercial snapshots (`hash_alg =
 * 'sha256-jcs-v1'`), the deterministic subset of RFC 8785 (JCS) the snapshots
 * need: object keys sorted by UTF-16 code units (JavaScript's default sort,
 * as JCS requires), arrays kept in order, no insignificant whitespace,
 * strings escaped as JSON.stringify does (identical to JCS for strings).
 * Deliberately STRICTER than JCS: only safe integers are accepted as numbers
 * (money travels as decimal strings), and undefined / bigint / NaN /
 * functions / non-plain objects throw instead of being silently dropped — a
 * snapshot that cannot be represented exactly must fail, never be hashed.
 */
export const CANONICAL_HASH_ALG = "sha256-jcs-v1";

export type CanonicalValue = null | boolean | string | number | CanonicalValue[] | { [key: string]: CanonicalValue };

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError(`canonical JSON accepts only safe integers, got ${value}`);
      return String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("canonical JSON accepts only plain objects");
      const entries = Object.keys(value as Record<string, unknown>).sort();
      return `{${entries.map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot represent a value of type ${typeof value}`);
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** The SHA-256 (hex) of the canonical form — what `proposal_versions.content_sha256` stores. */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
