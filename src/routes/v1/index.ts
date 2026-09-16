import { Router } from "express";
import { applicationsRouter } from "./applications.js";
import { healthRouter } from "./health.js";
import { meRouter } from "./me.js";
import { organizationsRouter } from "./organizations.js";
import { permissionsRouter } from "./permissions.js";
import { plansRouter } from "./plans.js";
import { rolesRouter } from "./roles.js";
import { subscriptionsRouter } from "./subscriptions.js";

export const v1Router = Router();

v1Router.use(healthRouter);
v1Router.use(meRouter);
v1Router.use(organizationsRouter);
v1Router.use(rolesRouter);
v1Router.use(permissionsRouter);
v1Router.use(applicationsRouter);
v1Router.use(plansRouter);
v1Router.use(subscriptionsRouter);
