import { z } from "zod";

const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric with single hyphens");

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema.optional(),
});

export const updateOrganizationSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    slug: slugSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "At least one field is required");
