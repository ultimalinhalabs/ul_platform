import { z } from "zod";

export const createEnvironmentSchema = z.object({
  key: z.string().min(1),
});

export const updateEnvironmentSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]),
});
