import { z } from "zod";

/** `domain.action` convention (see README "Event Types") — rejects empty strings and free-form garbage without pretending to own a global event catalog. */
const eventTypePattern = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const eventTypeSchema = z
  .string()
  .min(1)
  .regex(eventTypePattern, 'event type must follow the "domain.action" convention, e.g. "payment.completed"');

export const createWebhookEndpointSchema = z.object({
  applicationKey: z.string().min(1),
  url: z.string().url(),
  eventTypes: z.array(eventTypeSchema).min(1, "at least one event type subscription is required"),
});

export const publishEventSchema = z.object({
  type: eventTypeSchema,
  data: z.record(z.string(), z.unknown()).default({}),
});
