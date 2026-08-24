import { Router } from 'express';
import * as productStockController from './procuct-addstock.controller.js';
import { Auth } from '../../shared/middlewares/auth.js';


export const productStockRouter = Router();

productStockRouter.use(Auth);
productStockRouter.get('/inactive-stock/:st_id/:log_code', productStockController.ListInactiveStock);
productStockRouter.get('/movement-log/:st_id/:log_code', productStockController.ListInventoryMovement);
productStockRouter.get('/inventory-log/:st_id/:inv_id', productStockController.ListInventoryLog);
productStockRouter.get('/:st_id/:log_code', productStockController.list);
productStockRouter.post('/add-stock', productStockController.addStock);
productStockRouter.put('/reduce-stock', productStockController.reduceStock);
