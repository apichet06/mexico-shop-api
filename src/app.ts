import express from "express";
import cors from "cors";
import helmet from "helmet";

import { requestLogger } from "./shared/middlewares/requestLogger.js";
import { notFound } from "./shared/middlewares/notFound.js";
import { errorHandler } from "./shared/errors/errorHandler.js";

import { healthRoutes } from "./modules/health/health.routes.js";
import { usersRouters } from "./modules/users/users.routes.js";
import { catalogRouters } from "./modules/catalogs/catalog.routes.js";
import { categoryRouters } from "./modules/categorys/category.routes.js";
import BrandRouter from "./modules/brands/brands.routes.js";
import { unitRouters } from "./modules/units/units.routes.js";
import { ProductTagRouter } from "./modules/productTags/productTags.routes.js";
import { storeRouter } from "./modules/stores/store.routes.js";
import path from "path";
import { LocationRouter } from "./modules/locations/location.routes.js";
import { EmpRouter } from "./modules/employees/emp.routes.js";
import { productStatus } from "./modules/productStatus/productStatus.routes.js";
import { productRouter } from "./modules/product/product.routes.js";
import { OptionTypeRouter } from "./modules/optionType/optiontype.routes.js";
import { productStockRouter } from "./modules/product-addstock/product-addstock.routes.js";
import { landingPageRouter } from "./modules/landingpage/landingpage.routes.js";
import { productShopRouter } from "./modules/productshop/productshop.routes.js";
import { NotiRouter } from "./modules/notifications/notification.routes.js";
import { registerBuyerRouter } from "./modules/register-buyer/register-buyer.routes.js";
import { cartRouter } from "./modules/carts/carts.routes.js";
import { orderRouter } from "./modules/orders/orders.routes.js";
import { chatRouter } from "./modules/chat/chat.routes.js";
import { reviewRouter } from "./modules/reviews/reviews.routes.js";
import { couponRouter } from "./modules/coupons/coupon.routes.js";
import { shippingRouter } from "./modules/shipping/shipping.routes.js";
import { paymentRouter } from "./modules/payments/payment.routes.js";
import { statusRouters } from "./modules/statuses/statuses.routes.js";
import { webhookRouter } from "./modules/webhooks/webhook.routes.js";
import { websiteThemeRouter } from "./modules/website-theme/website-theme.routes.js";
import { articleRouter } from "./modules/articles/articles.routes.js";
import { analyticsRouter } from "./modules/analytics/analytics.routes.js";
import { googleAnalyticsRouter } from "./modules/google-analytics/google-analytics.routes.js";
import { sellerApplicationRouter } from "./modules/seller-applications/seller-applications.routes.js";

export function createApp() {
  const app = express();
  app.use(helmet());

  const corsOptions = {
    origin: [
      "http://localhost:3000",
      "https://localhost:3000",
      "http://localhost:3001",
      "https://localhost:3001",
      "https://arcanabackoffice.dev.system-samt.com",
      "https://arcana-shop.dev.system-samt.com",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  };

  app.use(cors(corsOptions));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));
  app.use(requestLogger);

  app.use("/api", healthRoutes);
  app.use(
    "/api/uploads",
    express.static(path.join(process.cwd(), "public/uploads"), {
      setHeaders: (res) => {
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=86400");
      },
    }),
  );

  app.use("/api/users", usersRouters);
  app.use("/api/catalogs", catalogRouters);
  app.use("/api/categorys", categoryRouters);
  app.use("/api/brands", BrandRouter);
  app.use("/api/units", unitRouters);
  app.use("/api/productTags", ProductTagRouter);
  app.use("/api/stores", storeRouter);
  app.use("/api/locations", LocationRouter);
  app.use("/api/employee", EmpRouter);
  app.use("/api/productStatus", productStatus);
  app.use("/api/products", productRouter);
  app.use("/api/optionTypes", OptionTypeRouter);
  app.use("/api/produtStock", productStockRouter);
  app.use("/api/landingPage", landingPageRouter);
  app.use("/api/productShop", productShopRouter);
  app.use("/api/notifications", NotiRouter);
  app.use("/api/auth", registerBuyerRouter);
  app.use("/api/cart", cartRouter);
  app.use("/api/orders", orderRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/reviews", reviewRouter);
  app.use("/api/coupons", couponRouter);
  app.use("/api/shipping", shippingRouter);
  app.use("/api/payments", paymentRouter);
  app.use("/api/statuses", statusRouters);
  app.use("/api/webhooks", webhookRouter);
  app.use("/api/website-theme", websiteThemeRouter);
  app.use("/api/articles", articleRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/google-analytics", googleAnalyticsRouter);
  app.use("/api/seller-applications", sellerApplicationRouter);

  app.get("/", (_req, res) => {
    res.status(200).send("Arcana API is running");
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
