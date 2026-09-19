import { z } from "zod";

/** `API` is the only endpoint type in v1 — see modules/endpoints/service.ts. */
export const createEndpointSchema = z.object({
  type: z.literal("API"),
  baseUrl: z.string().min(1),
});

export const updateEndpointSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]),
});
