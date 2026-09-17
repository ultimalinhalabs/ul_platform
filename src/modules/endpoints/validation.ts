import { ValidationError } from "../../shared/errors.js";

const MAX_URL_LENGTH = 2048;

/**
 * Server-side rules for an `application_endpoints.baseUrl` (CLAUDE.md's
 * discovery prompt §9): must be a valid absolute `http(s)` URL, HTTPS is
 * mandatory for the `production` environment (never relaxed "for local
 * convenience" — a non-production environment may use `http` since it's
 * expected to point at a developer/staging box), no embedded userinfo
 * (`https://user:pass@host` — a URL is a location, never a credential
 * carrier), and no fragment (meaningless for a base API URL, and a place
 * secrets/state could accidentally get pasted into config).
 *
 * A plain function, not a Zod schema: this needs the *environment's own
 * key* alongside the URL to decide the HTTPS rule, and is called from the
 * service layer (seed data, tests, and eventually a future admin
 * mutation) rather than parsed once at an HTTP request boundary.
 */
export function validateEndpointUrl(rawUrl: string, environmentKey: string): void {
  if (rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    throw new ValidationError(`baseUrl must be between 1 and ${MAX_URL_LENGTH} characters`);
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError("baseUrl must be a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("baseUrl must use http or https");
  }
  if (environmentKey === "production" && url.protocol !== "https:") {
    throw new ValidationError("baseUrl must use HTTPS in the production environment");
  }
  if (url.username || url.password) {
    throw new ValidationError("baseUrl must not embed credentials");
  }
  if (url.hash) {
    throw new ValidationError("baseUrl must not include a fragment");
  }
}
