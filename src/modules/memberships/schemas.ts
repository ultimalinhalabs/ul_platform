import { z } from "zod";

const statusSchema = z.enum(["active", "invited", "suspended"]);

export const createMembershipSchema = z.object({
  userId: z.string().uuid(),
  roleKey: z.string().min(1),
  status: statusSchema.optional(),
});

export const updateMembershipSchema = z
  .object({
    roleKey: z.string().min(1).optional(),
    status: statusSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "At least one field is required");
