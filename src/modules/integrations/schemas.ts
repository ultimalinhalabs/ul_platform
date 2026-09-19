import { z } from "zod";

export const createIntegrationSchema = z.object({
  description: z.string().optional(),
});

export const updateIntegrationSchema = z
  .object({
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
    description: z.string().optional(),
  })
  .refine((v) => v.status !== undefined || v.description !== undefined, {
    message: "At least one field must be provided",
  });
