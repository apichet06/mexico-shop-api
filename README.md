my-api/
├─ src/
│  ├─ app.ts
│  ├─ server.ts
│  ├─ config/
│  │  └─ env.ts
│  ├─ shared/
│  │  ├─ errors/
│  │  │  ├─ ApiError.ts
│  │  │  └─ errorHandler.ts
│  │  ├─ middlewares/
│  │  │  ├─ notFound.ts
│  │  │  └─ requestLogger.ts
│  │  └─ utils/
│  │     └─ asyncHandler.ts
│  ├─ db/
│  │  └─ pool.ts
│  └─ modules/
│     ├─ health/
│     │  ├─ health.controller.ts
│     │  ├─ health.routes.ts
│     │  └─ health.service.ts
│     └─ users/
│        ├─ users.controller.ts
│        ├─ users.routes.ts
│        ├─ users.service.ts
│        └─ users.types.ts
├─ .env.example
├─ package.json
├─ tsconfig.json
└─ README.md
# mexico-shop-api

## Conekta test webhook

The API receives `order.paid` and `order.pending_payment` at `POST /api/webhooks/conekta`.
It verifies Conekta's `DIGEST` signature against the raw request body using
`CONEKTA_WEBHOOK_PUBLIC_KEY`. Use the active **test mode** webhook public key
from the same Conekta account as `CONEKTA_PRIVATE_KEY`.

After deploying the API and setting both keys on the server, verify that an
unsigned POST to the public endpoint returns HTTP 401. Then create the test
webhook once with:

```sh
node scripts/create-conekta-webhook.mjs https://your-api.example/api/webhooks/conekta
```

The script checks that the configured test public key matches Conekta, that
the endpoint responds, and that a webhook for the URL does not already exist.
Use `node scripts/check-conekta-webhook.mjs` to inspect the registered webhook.
For a local signature check, run `npm run build` followed by
`node scripts/test-conekta-webhook.mjs`.
