import { Router } from 'express';
import * as controller from './catalog.controller.js';

export const catalogRouters = Router();

catalogRouters.get("/", controller.list);