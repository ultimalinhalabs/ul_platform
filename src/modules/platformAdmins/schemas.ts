import { z } from "zod";

export const grantPlatformAdminSchema = z.object({
  userId: z.string().uuid(),
  /** Optional: v1 only ever seeds "PLATFORM_ADMIN" — see db/schema/platformRoles.ts. */
  platformRoleKey: z.string().min(1).optional().default("PLATFORM_ADMIN"),
});

export const updatePlatformAdminSchema = z
  .object({
    status: z.enum(["ACTIVE", "REVOKED"]).optional(),
    platformRoleKey: z.string().min(1).optional(),
  })
  .refine((v) => v.status !== undefined || v.platformRoleKey !== undefined, {
    message: "At least one of status or platformRoleKey must be provided",
  });
