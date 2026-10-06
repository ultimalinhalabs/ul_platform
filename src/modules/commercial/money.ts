import { z } from "zod";
import { ValidationError } from "../../shared/errors.js";

/**
 * Block 1B — money is ALWAYS an integer number of minor units (bigint in the
 * database and in memory) plus an explicit currency on the version. AOA has
 * two decimals (ISO 4217, and the convention Na Pista already uses with
 * numeric(14,2)): 1 Kz = 100 minor units, so 100 000 Kz = 10 000 000.
 * Formatting for humans belongs to the frontends. Never a float, never
 * Number arithmetic on amounts; on the wire, amounts are decimal strings.
 */
export const MAX_MINOR = 9_223_372_036_854_775_807n; // Postgres bigint max

/** Accepts "25000000" or a safe non-negative integer; anything else (negative, decimal, exponent, > bigint) is a 400. */
export const minorAmountSchema = z
  .union([z.string().regex(/^(0|[1-9][0-9]{0,18})$/, "amount must be a non-negative integer of minor units"), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => BigInt(value))
  .refine((value) => value <= MAX_MINOR, "amount exceeds the supported range");

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code such as AOA");

export function lineTotalMinor(quantity: number, unitPriceMinor: bigint): bigint {
  const total = BigInt(quantity) * unitPriceMinor;
  if (total > MAX_MINOR) throw new ValidationError("Line total exceeds the supported range");
  return total;
}

export function sumMinor(values: bigint[]): bigint {
  const total = values.reduce((acc, value) => acc + value, 0n);
  if (total > MAX_MINOR) throw new ValidationError("Total exceeds the supported range");
  return total;
}

export const minorToString = (value: bigint | null | undefined) => (value === null || value === undefined ? null : value.toString());
