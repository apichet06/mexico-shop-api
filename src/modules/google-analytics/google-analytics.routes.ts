import { Router } from "express";
import { Auth } from "../../shared/middlewares/auth.js";
import * as controller from "./google-analytics.controller.js";

export const googleAnalyticsRouter = Router();

googleAnalyticsRouter.get("/dashboard", Auth, controller.getDashboard);
