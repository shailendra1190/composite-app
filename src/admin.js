const express = require("express");
const { pool } = require("./db");
const { requiredEnv, isValidShop, decryptAccessToken, verifySessionToken } = require("./shopify");
const { requestShopifyGraphql } = require("./shopify-admin-api");
const { readCursor, getCursorPage } = require("./shopify-pagination");

const router = express.Router();
const PRODUCT_ID = /^gid:\/\/shopify\/Product\/[0-9]+$/;
const VARIANT_ID = /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/;

function requestShop(req) {
  const shop = String(req.query.shop || req.body?.shop || "").toLowerCase();
  return isValidShop(shop) ? shop : null;
}

async function authenticate(req, res, next) {
  const shop = requestShop(req);
  const token = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!shop || !verifySessionToken(token, shop)) {
    return res.status(401).json({ error: "Your Shopify session expired. Reload the app and try again." });
  }
  try {
    const [rows] = await pool.execute(
      "SELECT id, access_token_encrypted FROM shops WHERE shop_domain = ? AND uninstalled_at IS NULL LIMIT 1",
      [shop]
    );
    if (!rows.length || !rows[0].access_token_encrypted) {
      return res.status(403).json({ error: "This shop is not installed. Install the app to continue." });
    }
    req.shop = shop;
    req.shopId = rows[0].id;
    req.accessToken = decryptAccessToken(rows[0].access_token_encrypted);
    next();
  } catch (error) {
    next(error);
  }
}

async function shopifyGraphql(req, query, variables = {}) {
  return requestShopifyGraphql({
    shop: req.shop,
    accessToken: req.accessToken,
    version: process.env.SHOPIFY_API_VERSION || "2026-10",
    query,
    variables
  });
}

async function validateConfiguration(req, input) {
  if (!input || typeof input !== "object" || typeof input.parentProductId !== "string" || !PRODUCT_ID.test(input.parentProductId)) {
    throw Object.assign(new Error("Choose a valid parent product."), { status: 400 });
  }
  if (!Array.isArray(input.groups) || input.groups.length > 100) {
    throw Object.assign(new Error("Add between zero and 100 component groups."), { status: 400 });
  }

  const seenGroupKeys = new Set();
  const variantIds = new Set();
  const groups = input.groups.map((group, groupIndex) => {
    if (!group || typeof group !== "object") throw Object.assign(new Error(`Group ${groupIndex + 1} is invalid.`), { status: 400 });
    const key = String(group.key || "");
    const name = typeof group.name === "string" ? group.name.trim() : "";
    const description = group.description === undefined ? "" : group.description;
    if (typeof description !== "string") throw Object.assign(new Error(`${name || `Group ${groupIndex + 1}`}: description must be text.`), { status: 400 });
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key) || seenGroupKeys.has(key)) {
      throw Object.assign(new Error(`Group ${groupIndex + 1} has an invalid or repeated identifier.`), { status: 400 });
    }
    seenGroupKeys.add(key);
    if (!name || name.length > 255 || description.length > 2000) {
      throw Object.assign(new Error(`Group ${groupIndex + 1} needs a name (up to 255 characters); descriptions are limited to 2,000 characters.`), { status: 400 });
    }
    if (typeof group.required !== "boolean") throw Object.assign(new Error(`${name}: choose whether this group is required.`), { status: 400 });
    const required = group.required;
    const selectionType = group.selectionType;
    if (!["single", "multiple"].includes(selectionType)) throw Object.assign(new Error(`${name}: choose single or multiple selection.`), { status: 400 });
    const min = group.minSelections;
    const max = group.maxSelections === undefined || group.maxSelections === null ? null : group.maxSelections;
    if (!Number.isInteger(min) || min < (required ? 1 : 0) || min > 100 ||
        (max !== null && (!Number.isInteger(max) || max < min || max > 100)) ||
        (selectionType === "single" && (min > 1 || (max !== null && max > 1)))) {
      throw Object.assign(new Error(`${name}: selection minimum and maximum are inconsistent.`), { status: 400 });
    }
    if (!Array.isArray(group.options) || group.options.length > 100) throw Object.assign(new Error(`${name}: add up to 100 options.`), { status: 400 });
    const optionIds = new Set();
    const options = group.options.map((option, optionIndex) => {
      if (!option || typeof option.productId !== "string" || !PRODUCT_ID.test(option.productId) ||
          typeof option.variantId !== "string" || !VARIANT_ID.test(option.variantId)) {
        throw Object.assign(new Error(`${name}: option ${optionIndex + 1} needs a Shopify product and variant.`), { status: 400 });
      }
      if (optionIds.has(option.variantId)) throw Object.assign(new Error(`${name}: each variant can appear only once.`), { status: 400 });
      optionIds.add(option.variantId);
      variantIds.add(option.variantId);
      const quantity = option.quantity;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw Object.assign(new Error(`${name}: option quantities must be from 1 to 1,000.`), { status: 400 });
      const label = option.label === undefined ? "" : option.label;
      if (typeof label !== "string") throw Object.assign(new Error(`${name}: option labels must be text.`), { status: 400 });
      if (label.length > 255) throw Object.assign(new Error(`${name}: option labels are limited to 255 characters.`), { status: 400 });
      if (typeof option.isDefault !== "boolean") throw Object.assign(new Error(`${name}: choose whether each option is a default.`), { status: 400 });
      return { productId: option.productId, variantId: option.variantId, label: label.trim(), quantity, isDefault: option.isDefault };
    });
    const defaultCount = options.filter((option) => option.isDefault).length;
    if (options.length < min) throw Object.assign(new Error(`${name}: add enough options to satisfy the minimum selection.`), { status: 400 });
    if ((selectionType === "single" && defaultCount > 1) || (max !== null && defaultCount > max)) {
      throw Object.assign(new Error(`${name}: default selections exceed the selection maximum.`), { status: 400 });
    }
    return { key, name, description, required, selectionType, minSelections: min, maxSelections: max, sortOrder: groupIndex, options };
  });

  const ids = [input.parentProductId, ...variantIds];
  if (ids.length > 250) throw Object.assign(new Error("A configuration can contain up to 249 variants."), { status: 400 });
  let parentProductTitle;
  if (ids.length >= 1) {
    const data = await shopifyGraphql(req,
      "query ValidateNodes($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on Product { id title } ... on ProductVariant { id product { id } } } }",
      { ids }
    );
    const nodes = data.nodes || [];
    if (nodes[0]?.__typename !== "Product" || nodes[0].id !== input.parentProductId || !nodes[0].title || nodes[0].title.length > 255) {
      throw Object.assign(new Error("The selected parent product could not be verified in this shop."), { status: 400 });
    }
    parentProductTitle = nodes[0].title;
    const validVariants = new Map(nodes.slice(1).filter((node) => node?.__typename === "ProductVariant").map((node) => [node.id, node.product?.id]));
    for (const group of groups) for (const option of group.options) {
      if (validVariants.get(option.variantId) !== option.productId) {
        throw Object.assign(new Error(`${group.name}: one or more options do not match a product in this shop.`), { status: 400 });
      }
    }
  }
  return { parentProductId: input.parentProductId, parentProductTitle, groups };
}

router.get("/api/products", authenticate, async (req, res, next) => {
  try {
    const after = readCursor(req.query.after);
    const page = await getCursorPage(({ after: cursor }) => shopifyGraphql(req,
      `query ProductPicker($after: String) {
        products(first: 10, after: $after, sortKey: TITLE) {
          pageInfo { hasNextPage endCursor }
          edges { node { id title featuredImage { url } variants(first: 50) { pageInfo { hasNextPage endCursor } edges { node { id title sku price } } } } }
        }
      }`, { after: cursor }).then((data) => data.products), {
      cursor: after,
      first: 10,
      mapNode: (node) => ({
      id: node.id, title: node.title, image: node.featuredImage?.url || null,
      variants: node.variants.edges.map(({ node: variant }) => ({ id: variant.id, title: variant.title, sku: variant.sku, price: variant.price })),
      variantsHasNext: node.variants.pageInfo.hasNextPage, variantsCursor: node.variants.pageInfo.endCursor
      })
    });
    res.json({ products: page.items, pageInfo: page.pageInfo });
  } catch (error) { next(error); }
});

router.get("/api/product-variants", authenticate, async (req, res, next) => {
  try {
    const productId = String(req.query.productId || "");
    const after = readCursor(req.query.after, true);
    if (!PRODUCT_ID.test(productId)) return res.status(400).json({ error: "A valid product is required." });
    const page = await getCursorPage(({ after: cursor }) => shopifyGraphql(req,
      "query ProductVariantPicker($id: ID!, $after: String) { product(id: $id) { variants(first: 250, after: $after) { pageInfo { hasNextPage endCursor } edges { node { id title sku price } } } } }",
      { id: productId, after: cursor }).then((data) => {
        if (!data.product) {
          const error = new Error("The product could not be found in this shop.");
          error.status = 404;
          throw error;
        }
        return data.product.variants;
      }), {
      cursor: after,
      first: 250,
      mapNode: (node) => ({ id: node.id, title: node.title, sku: node.sku, price: node.price })
    });
    res.json({ variants: page.items, pageInfo: page.pageInfo });
  } catch (error) { next(error); }
});

router.get("/api/config", authenticate, async (req, res, next) => {
  try {
    const productId = String(req.query.productId || "");
    if (!PRODUCT_ID.test(productId)) return res.status(400).json({ error: "Choose a valid parent product." });
    const [rows] = await pool.execute(
      "SELECT configuration_json, updated_at FROM composite_products WHERE shop_id = ? AND shopify_product_id = ? LIMIT 1",
      [req.shopId, productId]
    );
    const row = rows[0];
    res.json({ config: row ? (typeof row.configuration_json === "string" ? JSON.parse(row.configuration_json) : row.configuration_json) : null, updatedAt: row?.updated_at || null });
  } catch (error) { next(error); }
});

router.post("/api/config", authenticate, async (req, res, next) => {
  let connection;
  try {
    const config = await validateConfiguration(req, req.body);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO composite_products (shop_id, shopify_product_id, title, enabled, configuration_json)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), enabled = 1, configuration_json = VALUES(configuration_json), updated_at = CURRENT_TIMESTAMP`,
      [req.shopId, config.parentProductId, config.parentProductTitle, JSON.stringify(config)]
    );
    await connection.commit();
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    next(error);
  } finally { connection?.release(); }
});

router.get("/admin", (req, res) => {
  res.set("Content-Security-Policy", "frame-ancestors https://admin.shopify.com https://*.myshopify.com");
  res.type("html").send(adminPage());
});

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || 500;
  if (status >= 500) console.error("Admin configuration request failed:", error);
  if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
  res.status(status).json({ error: status >= 500 ? "The request could not be completed. Please try again." : error.message });
});

function adminPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="shopify-api-key" content="${escapeHtml(requiredEnv("SHOPIFY_API_KEY"))}"><title>Composite product builder</title>
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script><style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202223;background:#f6f6f7;font-size:14px}*{box-sizing:border-box}body{margin:0}header{background:#fff;border-bottom:1px solid #e1e3e5;padding:20px max(24px,calc((100% - 1120px)/2));display:flex;justify-content:space-between;align-items:center}h1{font-size:22px;margin:0}main{max-width:1120px;margin:28px auto;padding:0 20px}.card{background:#fff;border:1px solid #e1e3e5;border-radius:12px;padding:22px;margin:0 0 16px;box-shadow:0 1px 2px #0000000d}.row{display:flex;gap:12px;align-items:center}.between{justify-content:space-between}label{display:block;font-weight:600;margin:0 0 7px}input,select,textarea{font:inherit;border:1px solid #8c9196;border-radius:7px;background:#fff;padding:10px;width:100%;color:#202223}textarea{min-height:70px;resize:vertical}.field{flex:1;min-width:160px;margin:12px 0}.muted{color:#6d7175}.btn{border:1px solid #8c9196;border-radius:7px;background:#fff;padding:9px 13px;font:inherit;font-weight:600;cursor:pointer}.primary{background:#008060;border-color:#008060;color:white}.danger{color:#b42318}.group{border:1px solid #d2d5d8;border-radius:10px;padding:18px;margin-top:14px}.option{display:grid;grid-template-columns:2fr 1fr 100px 100px auto;gap:10px;align-items:end;border-top:1px solid #eee;padding:12px 0}.option:first-of-type{margin-top:8px}.notice{padding:12px;border-radius:8px;background:#f1f8f5;color:#145c43;margin:12px 0}.error{background:#fff1f0;color:#8e1b10}.hide{display:none}.badge{font-size:12px;color:#5c5f62}.move{display:flex;gap:5px}#status{min-height:20px}.picker{max-width:540px}.option select{min-width:0}@media(max-width:740px){.row{flex-wrap:wrap}.option{grid-template-columns:1fr 1fr}.option>*{min-width:0}}
</style></head><body><header><h1>Composite product builder</h1><span class="muted">Admin configuration</span></header><main>
<div id="status" role="status"></div><section class="card"><h2>Parent product</h2><p class="muted">Choose the Shopify product customers will configure.</p><div class="row"><div class="field"><label for="parent">Product</label><select id="parent"><option value="">Loading products…</option></select></div><button class="btn" id="loadMoreProducts" type="button">Load more products</button><button class="btn" id="reload" type="button">Reload products</button></div></section>
<section class="card"><div class="row between"><div><h2>Component groups</h2><p class="muted">Arrange required or optional choices for this product.</p></div><button class="btn" id="addGroup">Add group</button></div><div id="groups"></div></section>
<div class="row between"><span id="saved" class="muted"></span><button class="btn primary" id="save">Save configuration</button></div></main>
<dialog id="picker" class="picker"><form method="dialog"><div class="row between"><h2 id="pickerTitle">Add component option</h2><button class="btn">Close</button></div><div class="field"><label for="pickProduct">Product</label><select id="pickProduct"></select><button class="btn" id="loadMoreDialogProducts" type="button">Load more products</button></div><div class="field"><label for="pickVariant">Variant</label><select id="pickVariant"></select><button class="btn" id="loadMoreVariants" type="button">Load more variants</button></div><button class="btn primary" id="confirmOption">Add option</button></form></dialog>
<script>
const shop=new URLSearchParams(location.search).get('shop');const products=[];let groups=[];let busy=false;let productsCursor=null;let hasMoreProducts=true;let productsLoading=false;
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function message(text,error=false){$('#status').innerHTML=text?'<div class="notice '+(error?'error':'')+'">'+esc(text)+'</div>':''}
async function api(url,opts={}){if(!window.shopify?.idToken)throw Error('Open this page from Shopify Admin to start a secure session.');const token=await window.shopify.idToken();const r=await fetch(url,{...opts,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,...opts.headers}});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
function productOptions(selected=''){return '<option value="">Select a product…</option>'+products.map(p=>'<option value="'+esc(p.id)+'" '+(p.id===selected?'selected':'')+'>'+esc(p.title)+'</option>').join('')}
function syncProductSelects(){const parentValue=$('#parent').value,pickerValue=$('#pickProduct').value,variantValue=$('#pickVariant').value;$('#parent').innerHTML=productOptions(parentValue);$('#pickProduct').innerHTML=productOptions(pickerValue);if(pickerValue)populateVariantPicker(variantValue).catch(e=>message(e.message,true));else $('#pickProduct').onchange()}
async function loadProducts(reset=false){while(productsLoading)await new Promise(resolve=>setTimeout(resolve,25));if(!reset&&!hasMoreProducts)return false;productsLoading=true;const parent=$('#parent'),more=$('#loadMoreProducts'),dialogMore=$('#loadMoreDialogProducts');let parentValue=parent.value;if(reset){parentLoadId++;products.length=0;productsCursor=null;hasMoreProducts=true;parentValue='';groups=[];configReady=false;$('#save').disabled=true;$('#saved').textContent='';render();parent.innerHTML='<option>Loading products…</option>'}more.disabled=true;dialogMore.disabled=true;message('Loading products…');try{const url='/api/products?shop='+encodeURIComponent(shop)+(productsCursor?'&after='+encodeURIComponent(productsCursor):'');const page=await api(url);products.push(...page.products);hasMoreProducts=page.pageInfo.hasNextPage;productsCursor=page.pageInfo.endCursor;syncProductSelects();if(parentValue)parent.value=parentValue;more.hidden=dialogMore.hidden=!hasMoreProducts;if(!products.length)message('No products found. Add a product in Shopify and reload.',true);else message('');return true}catch(e){if(reset)parent.innerHTML='<option value="">Products could not be loaded</option>';message(e.message,true);return false}finally{productsLoading=false;more.disabled=dialogMore.disabled=!hasMoreProducts}}
async function loadMoreVariants(product,untilVariantId=null){if(!product)return false;while(product.variantsHasNext&&(!untilVariantId||!product.variants.some(v=>v.id===untilVariantId))){const cursor=product.variantsCursor;const page=await api('/api/product-variants?shop='+encodeURIComponent(shop)+'&productId='+encodeURIComponent(product.id)+'&after='+encodeURIComponent(cursor));product.variants.push(...page.variants);product.variantsHasNext=page.pageInfo.hasNextPage;product.variantsCursor=page.pageInfo.endCursor;if(product.variantsHasNext&&(!product.variantsCursor||product.variantsCursor===cursor))throw Error('Shopify did not return a new variant page. Reload products and retry.');if(!untilVariantId)break}return !untilVariantId||product.variants.some(v=>v.id===untilVariantId)}
async function ensureConfigOptions(optionGroups){const options=optionGroups.flatMap(g=>g.options||[]);while(options.some(o=>!products.some(p=>p.id===o.productId))&&hasMoreProducts){if(!await loadProducts(false))throw Error('Could not load all products needed by this configuration. Retry loading products.')}if(options.some(o=>!products.some(p=>p.id===o.productId)))throw Error('A saved component product is no longer available in this Shopify catalog.');for(const product of products){const wanted=options.filter(o=>o.productId===product.id).map(o=>o.variantId);for(const id of wanted)if(!product.variants.some(v=>v.id===id)&&!await loadMoreVariants(product,id))throw Error('A saved component variant is no longer available in Shopify.')}}
function variantLabel(o){const p=products.find(x=>x.id===o.productId),v=p?.variants.find(x=>x.id===o.variantId);return p&&v?p.title+' · '+v.title+(v.sku?' · '+v.sku:''):'Selected Shopify variant'}
function render(){const root=$('#groups');root.innerHTML=groups.map((g,i)=>'<article class="group" data-i="'+i+'"><div class="row between"><strong>Group '+(i+1)+'</strong><span class="move"><button class="btn" data-act="up" '+(!i?'disabled':'')+' aria-label="Move group up">↑</button><button class="btn" data-act="down" '+(i===groups.length-1?'disabled':'')+' aria-label="Move group down">↓</button><button class="btn danger" data-act="delete">Delete</button></span></div><div class="row"><div class="field"><label>Name</label><input data-f="name" maxlength="255" value="'+esc(g.name)+'" placeholder="Choose a size"></div><div class="field"><label>Selection</label><select data-f="selectionType"><option value="single" '+(g.selectionType==='single'?'selected':'')+'>Single</option><option value="multiple" '+(g.selectionType==='multiple'?'selected':'')+'>Multiple</option></select></div><div class="field"><label>Required?</label><select data-f="required"><option value="true" '+(g.required?'selected':'')+'>Required</option><option value="false" '+(!g.required?'selected':'')+'>Optional</option></select></div></div><div class="field"><label>Description</label><textarea data-f="description" maxlength="2000" placeholder="Help customers choose">'+esc(g.description)+'</textarea></div><div class="row"><div class="field"><label>Minimum selections</label><input type="number" min="0" max="100" data-f="minSelections" value="'+g.minSelections+'"></div><div class="field"><label>Maximum selections</label><input type="number" min="1" max="100" data-f="maxSelections" value="'+(g.maxSelections??'')+'" placeholder="No limit"></div></div><div class="row between"><strong>Component options</strong><button class="btn" data-act="addOption">Add option</button></div>'+g.options.map((o,j)=>'<div class="option" data-j="'+j+'"><div><label>Variant</label><div>'+esc(variantLabel(o))+'</div><button class="btn" data-act="changeOption">Change variant</button></div><div><label>Label (optional)</label><input data-o="label" maxlength="255" value="'+esc(o.label)+'" placeholder="Custom label"></div><div><label>Quantity</label><input type="number" min="1" max="1000" data-o="quantity" value="'+o.quantity+'"></div><label><input type="checkbox" data-o="isDefault" '+(o.isDefault?'checked':'')+'> Default</label><button class="btn danger" data-act="removeOption">Remove</button></div>').join('')+'</article>').join('')}
function makeGroup(){return {key:crypto.randomUUID().replaceAll('-',''),name:'',description:'',required:true,selectionType:'single',minSelections:1,maxSelections:1,options:[]}}
$('#addGroup').onclick=()=>{groups.push(makeGroup());render()};$('#reload').onclick=()=>loadProducts(true);$('#loadMoreProducts').onclick=()=>loadProducts(false);$('#loadMoreDialogProducts').onclick=()=>loadProducts(false);
function updateOptionField(card,target){const field=target.dataset.o;if(!field||field==='variant')return;const option=groups[+card.dataset.i].options[+target.closest('.option').dataset.j];option[field]=field==='isDefault'?target.checked:(field==='quantity'?Number(target.value):target.value)}
$('#groups').addEventListener('input',e=>{const card=e.target.closest('.group');if(!card)return;const g=groups[+card.dataset.i];if(e.target.dataset.f){const k=e.target.dataset.f;g[k]=e.target.type==='number'?Number(e.target.value):e.target.value;if(k==='required')g[k]=e.target.value==='true';if(k==='maxSelections')g[k]=e.target.value===''?null:Number(e.target.value)}updateOptionField(card,e.target)});
$('#groups').addEventListener('change',e=>{const card=e.target.closest('.group');if(!card)return;const g=groups[+card.dataset.i];if(e.target.dataset.f){const k=e.target.dataset.f;g[k]=k==='required'?e.target.value==='true':(k==='minSelections'?Number(e.target.value):(k==='maxSelections'?(e.target.value===''?null:Number(e.target.value)):e.target.value));if(k==='selectionType'&&g.selectionType==='single'){g.maxSelections=1;g.minSelections=Math.min(1,g.minSelections)}render()}if(e.target.dataset.o==='variant'){const [productId,variantId]=e.target.value.split('|');Object.assign(g.options[+e.target.closest('.option').dataset.j],{productId,variantId});}else updateOptionField(card,e.target)});
$('#groups').addEventListener('click',async e=>{
  const btn=e.target.closest('[data-act]');if(!btn)return;
  const card=btn.closest('.group'),i=+card.dataset.i;
  try {
    switch(btn.dataset.act){
      case'delete':groups.splice(i,1);render();break;
      case'up':[groups[i-1],groups[i]]=[groups[i],groups[i-1]];render();break;
      case'down':[groups[i+1],groups[i]]=[groups[i],groups[i+1]];render();break;
      case'removeOption':groups[i].options.splice(+btn.closest('.option').dataset.j,1);render();break;
      case'changeOption':{
        const optionIndex=+btn.closest('.option').dataset.j,option=groups[i].options[optionIndex];
        while(!products.some(p=>p.id===option.productId)&&hasMoreProducts)if(!await loadProducts(false))return;
        const product=products.find(p=>p.id===option.productId);
        if(!product){message('The saved component product is no longer available.',true);return}
        if(!product.variants.some(v=>v.id===option.variantId)&&!await loadMoreVariants(product,option.variantId)){message('The saved component variant is no longer available.',true);return}
        if(groups[i]?.options[optionIndex]!==option)return;
        window.activeGroup=i;window.activeOption=optionIndex;$('#pickerTitle').textContent='Change component variant';$('#confirmOption').textContent='Save variant';$('#pickProduct').value=product.id;await populateVariantPicker(option.variantId);$('#picker').showModal();break
      }
      case'addOption':window.activeGroup=i;window.activeOption=null;$('#pickerTitle').textContent='Add component option';$('#confirmOption').textContent='Add option';$('#pickProduct').value='';$('#pickVariant').innerHTML='';$('#loadMoreVariants').hidden=true;$('#picker').showModal();break;
    }
  } catch(error) { message(error.message,true); }
});
async function populateVariantPicker(selectedId=''){const product=products.find(x=>x.id===$('#pickProduct').value),select=$('#pickVariant');if(product&&selectedId&&!product.variants.some(v=>v.id===selectedId)&&product.variantsHasNext)await loadMoreVariants(product,selectedId);select.innerHTML=(product?.variants||[]).map(v=>'<option value="'+esc(v.id)+'">'+esc(v.title+(v.sku?' · '+v.sku:''))+'</option>').join('');if(selectedId&&product?.variants.some(v=>v.id===selectedId))select.value=selectedId;$('#loadMoreVariants').hidden=!product?.variantsHasNext}
$('#pickProduct').onchange=async()=>{try{await populateVariantPicker()}catch(e){message(e.message,true)}};$('#loadMoreVariants').onclick=async()=>{const product=products.find(x=>x.id===$('#pickProduct').value),selected=$('#pickVariant').value;if(!product)return;const button=$('#loadMoreVariants');button.disabled=true;try{await loadMoreVariants(product);await populateVariantPicker(selected)}catch(e){message(e.message,true)}finally{button.disabled=false}};$('#confirmOption').onclick=e=>{e.preventDefault();const p=products.find(x=>x.id===$('#pickProduct').value),v=p?.variants.find(x=>x.id===$('#pickVariant').value);if(!p||!v)return;const group=groups[window.activeGroup];if(window.activeOption===null)group.options.push({productId:p.id,variantId:v.id,label:'',quantity:1,isDefault:false});else Object.assign(group.options[window.activeOption],{productId:p.id,variantId:v.id});window.activeOption=null;$('#picker').close();render()};
let parentLoadId=0;let configReady=false;
$('#parent').onchange=async()=>{const p=products.find(x=>x.id===$('#parent').value),loadId=++parentLoadId;groups=[];configReady=false;$('#save').disabled=true;$('#saved').textContent='';render();if(!p)return;message('Loading configuration…');try{const d=await api('/api/config?shop='+encodeURIComponent(shop)+'&productId='+encodeURIComponent(p.id));if(loadId!==parentLoadId)return;const loadedGroups=d.config?.groups||[];await ensureConfigOptions(loadedGroups);if(loadId!==parentLoadId)return;groups=loadedGroups;$('#saved').textContent=d.updatedAt?'Last saved '+new Date(d.updatedAt).toLocaleString():'';configReady=true;message('');render()}catch(e){if(loadId===parentLoadId)message(e.message,true)}finally{if(loadId===parentLoadId)$('#save').disabled=!configReady}};
$('#save').onclick=async()=>{const p=products.find(x=>x.id===$('#parent').value);if(!p){message('Choose a parent product first.',true);return}if(!configReady){message('Wait for this product’s configuration to finish loading, then try again.',true);return}if(busy)return;busy=true;$('#save').disabled=true;message('Saving…');try{const d=await api('/api/config?shop='+encodeURIComponent(shop),{method:'POST',body:JSON.stringify({parentProductId:p.id,groups})});message('Configuration saved.');$('#saved').textContent='Saved '+new Date(d.savedAt).toLocaleString()}catch(e){message(e.message,true)}finally{busy=false;$('#save').disabled=!configReady}};
loadProducts(true);
</script></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

module.exports = router;
