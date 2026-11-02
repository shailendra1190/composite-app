# Shopify Composite App — backend foundation

This package is the initial Node.js + MySQL foundation for the multi-store Shopify composite-product app.

## 1. Hostinger environment variables

Set these in the Node.js app environment settings (do not commit `.env`):

- `NODE_ENV=production`
- `PORT` (use the port required by Hostinger; otherwise the app defaults to 3000)
- `DB_HOST`
- `DB_PORT=3306`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`

Keep the database password private. Do not put it in GitHub or share it in chat.

## 2. Deploy

Upload the ZIP contents to the app repository/root, or push the extracted project to GitHub and connect that repository in Hostinger. Run `npm install` during deployment and use `npm start` as the start command.

## 3. Create the initial tables

Open Hostinger phpMyAdmin for this database, select the database, choose **Import**, and import `database/schema.sql`.

## 4. Verify

After deployment, open:

- `https://composite-app.relieverit.com/health`
- `https://composite-app.relieverit.com/health/db`

The second endpoint should return `{"ok":true,"database":"connected"}` when the DB settings and permissions are correct.

## 5. Shopify setup comes next

This foundation does not yet perform Shopify OAuth or expose the production admin/storefront UI. Those are the next implementation phase. Before enabling OAuth, configure the Shopify app in the Shopify Developer Dashboard and add the API key/secret as private Hostinger environment variables. Never expose the API secret or access tokens in frontend code.

## Data model

- `shops`: one record per installed Shopify store
- `composite_products`: composite configuration attached to a Shopify product
- `component_groups`: ordered required/optional selection groups
- `component_options`: selectable Shopify product variants in each group
