// Vercel Function entrypoint (Fase 5.2): serves the compiled Express app built
// by `npm run build` (dist/app.js) — the same app `npm start` serves. It never
// starts the webhook retry worker; that runs as its own process on Railway
// (`npm run start:worker` → dist/worker.js).
export { default } from "../dist/app.js";
