# Shopify Composite App — backend and Admin configuration

This Node.js + MySQL app provides Shopify OAuth installation and the first milestone of the composite product builder: an embedded Admin configuration page at `/admin`.

## Environment

Keep the existing environment variable names and configure them in the app host. Hostinger's Node.js app settings should contain:

- `NODE_ENV=production`
- `PORT` — use the port assigned by Hostinger; the app defaults to 3000 when unset
- `APP_URL` — public HTTPS app URL, without a trailing slash
- `SHOPIFY_API_KEY` — client ID; this is public and is used by App Bridge
- `SHOPIFY_API_SECRET` — private Shopify client secret; never expose it to the browser or logs
- `SHOPIFY_SCOPES=read_products` — minimum scope used by this milestone
- `SHOPIFY_API_VERSION=2026-10`
- `APP_ENCRYPTION_KEY` — strong random private value; keep it stable because stored tokens depend on it
- `DB_HOST`, `DB_PORT` (optional, defaults to 3306), `DB_NAME`, `DB_USER`, `DB_PASSWORD` — use the connection details shown for the Hostinger database

Do not put real credentials in `.env.example` or source control. Add them through Hostinger's environment-variable settings. [Hostinger environment variable guide](https://www.hostinger.com/support/how-to-add-environment-variables-during-node-js-application-deployment/)

Set the Shopify app URL to `${APP_URL}`, configure the app's access scope as `read_products`, and register `${APP_URL}/auth/callback` as an allowed redirect URL. Shopify's `shop` parameter sends the root page to `/admin`. The embedded page gets an App Bridge ID/session token for each API request; the server verifies its signature and shop claims, then uses the encrypted offline Admin API token stored for that same shop.

The current installation route uses the existing authorization-code OAuth flow. Keep it in place for this rollout; do not switch authentication grants without confirming the app's distribution type, Shopify app settings, and a tested token-exchange migration plan. Shopify's current embedded-app guidance favors token exchange, so treat that migration as a separate compatibility task before adopting managed installation.

The OAuth code currently stores only the offline access token. If this will be a public Shopify App Store app, it is not ready for public distribution: public apps must use expiring offline tokens and refresh-token rotation (new public apps are already subject to this; the deadline for existing public apps is January 1, 2027). Add that work to the confirmed authentication migration plan. Merchant-created custom apps are excluded from this requirement. [Shopify expiring-token requirement](https://shopify.dev/changelog/posts/migrate-to-expiring-offline-access-tokens-before-january-2027)

## Uninstall webhook

The endpoint is implemented at `${APP_URL}/webhooks/shopify` and verifies the exact raw request body before processing. This repository does not contain a `shopify.app.toml` or register the topic automatically:

For a Dev Dashboard app using app-specific subscriptions, add this to the app's linked `shopify.app.toml` (this repository does not currently include that file):

```toml
[webhooks]
api_version = "2026-10"

[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/webhooks/shopify"
```

Then run `shopify app deploy` from the linked Shopify app project to create/release the version. If creating it without release, open **Dev Dashboard → Apps → your app → Versions**, select the draft version, and release it there. Open the released version's **Configuration → Subscriptions** and confirm it lists `app/uninstalled` at `${APP_URL}/webhooks/shopify`; also confirm its Webhooks API Version is `2026-10`.

For a custom app created inside Shopify Admin, Shopify requires shop-specific registration through the GraphQL Admin API `webhookSubscriptionCreate` mutation for each shop; it cannot use CLI app config. This repository does not automate that registration, so include it in the app's installation/registration process before relying on uninstall delivery. Test the chosen path with a staging store. See [Shopify's webhook subscription guide](https://shopify.dev/docs/apps/build/webhooks/subscribe).

The handler compares the signed event's UTC timestamp to a microsecond-precision installation generation. Delayed uninstall deliveries older than the current installation cannot clear its token. The additive migrations below add and initialize that timestamp; apply them before deploying code that writes or reads it. If this app is distributed through the Shopify App Store, the mandatory `customers/data_request`, `customers/redact`, and `shop/redact` subscriptions and handlers must also be implemented before submission; they are not part of this milestone.

## Database

Use the existing `database/schema.sql` once to initialize a new database. It creates `shops`, `composite_products`, `component_groups`, and `component_options`. The admin milestone stores a complete configuration in the existing `composite_products.configuration_json` JSON column and does not alter or replace the schema. Each query is scoped by the installed shop's database ID.

### Versioned migrations

The migration runner is an additive system. Migrations 0001 and 0002 create the tracking table and record a verified baseline. Migration 0003 adds `shops.installation_generation_at DATETIME(6)`; migration 0004 initializes it for existing rows. None of these migrations drops or truncates merchant tables or deletes merchant rows. The runner checks required tables, columns, keys, and foreign keys before applying them, and refuses to adopt an empty or incompatible schema. A new database must first be initialized from `database/schema.sql`.

Migration SQL lives in `migrations/` and uses ordered names such as `0003_add_example_column.sql`. Versions must be contiguous, and an applied migration file must never be edited or removed. Use one SQL statement per file and make DDL safe to retry where MySQL supports it because MySQL DDL may commit independently of the history insert. Do not put credentials in migration files or command arguments.

Before using the runner against any database, configure the app's existing `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` environment variables in the hosting control panel. First inspect the target carefully and run the read-only status command:

```sh
npm run migrate:status
```

For a production migration, take and verify a full backup first. In Hostinger hPanel, use the database backup/export option if available; otherwise open phpMyAdmin, select the correct database, choose **Export** with **Structure and data** in SQL format, download the export, and verify it is non-empty and stored outside the web root. Keep a copy outside the hosting account. Confirm the database name shown in hPanel matches the intended app database. To restore, select the intended database and import the verified SQL backup through phpMyAdmin.

Run migrations from the Hostinger Node.js app terminal (or the equivalent shell) with the migration files and existing DB environment variables. For this release, apply 0003/0004 before starting the new app code, since OAuth and webhook handling use the added column. Re-run status, then apply explicitly:

```sh
npm run migrate:status
npm run migrate:up -- --confirm --backup-confirmed
```

`--confirm` and `--backup-confirmed` are required for every apply operation. `--backup-confirmed` is only a human acknowledgement: the runner does not inspect, create, or verify a backup. The runner uses the existing DB environment variables, obtains a MySQL advisory lock, checks schema compatibility and migration checksums, and prints applied versions without credentials. `migrate:status` connects to the configured database and runs read-only checks. Never run `migrate:up` until you have independently verified the backup. If a migration fails, inspect its state before retrying; do not edit an already recorded migration.

No migration command has been run as part of preparing these files, and no live database was accessed.

### Staging deployment and checks

1. Create a separate Shopify development/staging store and a staging Hostinger app/database. Set the environment variables above to staging values and use a separate strong `APP_ENCRYPTION_KEY`.
2. Select Node.js 20 or newer in Hostinger (the package declares `>=20`), install dependencies with `npm install`, and deploy the candidate release to staging. This repository currently has no npm lockfile; create and review one before production to make dependency installation repeatable. Then check `/health` and `/health/db`.
3. Confirm the OAuth install and callback complete, and that the embedded page obtains a fresh ID/session token. Test invalid/mismatched shop tokens are rejected.
4. Exercise product pagination across multiple pages and a high-variant product; verify retry/error feedback under Shopify throttling.
5. Save, reload, and edit configurations for two staging shops and confirm each shop sees only its own records.
6. Register `app/uninstalled` using the path for the staging app type, verify the subscription, uninstall the app, and confirm the token is cleared. Reinstall, then replay an older signed uninstall delivery in a controlled test; the new token must remain valid.
7. Run `npm test` and JavaScript syntax checks against the exact release candidate. Production migrations/deployment should follow only after staging passes and a verified backup exists.

For a custom app created inside Shopify Admin, use the per-shop GraphQL registration path described above instead of `shopify.app.toml`. The Dev Dashboard's **Versions** page can set the webhook API version and show deliveries; it does not replace registering a shop-specific subscription.

## Run

```sh
npm install
npm start
```

Health checks: `/health` and `/health/db`.

After installing through `/auth/install?shop=your-store.myshopify.com`, open the app from Shopify Admin. The product picker loads products and variants in cursor-based pages through the Admin GraphQL API. Configurations include parent product, ordered groups, selection rules, variant options, quantity, and defaults.

## Scope

This milestone covers Admin configuration only. Storefront rendering, cart integration, inventory behavior, and checkout behavior are not implemented.
