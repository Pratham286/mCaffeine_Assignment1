
require('dotenv').config();
const fs = require('fs');
const XLSX = require('xlsx');
const axios = require('axios');

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const GRAPHQL_URL = SHOP ? `https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json` : null;

if (!SHOP || !TOKEN) {
  console.error('ERROR: set SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN in .env');
  process.exit(1);
}

async function shopifyGraphql(query, variables = {}) {
  try {
    const resp = await axios.post(GRAPHQL_URL, { query, variables }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': TOKEN,
      },
      timeout: 30000,
    });

    if (resp.data.errors) {
      console.error('GraphQL errors:', JSON.stringify(resp.data.errors, null, 2));
      return { errors: resp.data.errors };
    }
    return resp.data.data || {};
  } catch (err) {
    console.error('Network/Shopify error:', err.response?.data || err.message || err);
    throw err;
  }
}

function parseSheet(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function buildInputsFromRow(row) {
  const title = (row.Title || row.title || '').toString().trim();
  if (!title) return null;

  const descriptionHtml = (row.BodyHtml || row.body_html || row.body || '').toString();
  const productType = (row.ProductType || row.productType || row.product_type || '').toString();
  const vendor = (row.Vendor || row.vendor || '').toString();
  const tags = (row.Tags || row.tags || '').toString()
    .split(',')
    .map(t => t.trim()).filter(Boolean);

  const productInput = { title, descriptionHtml, productType, vendor, tags };

  const metafieldNS = (row.MetafieldNS || row.metafieldNS || '').toString();
  const metafieldKey = (row.MetafieldKey || row.metafieldKey || '').toString();
  const metafieldValue = (row.MetafieldValue || row.metafieldValue || '').toString();
  const metafieldType = (row.MetafieldType || row.metafieldType || '').toString();
  if (metafieldNS && metafieldKey && metafieldValue && metafieldType) {
    productInput.metafields = [{ namespace: metafieldNS, key: metafieldKey, value: metafieldValue, type: metafieldType }];
  }

  const imagesRaw = (row.ImageURLs || row.imageURLs || row.Images || row.images || '').toString();
  const mediaInputs = imagesRaw
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(src => ({ mediaContentType: 'IMAGE', originalSource: src }));

  const priceRaw = row.Price || row.price || row.cost || '';
  const price = priceRaw === '' ? undefined : priceRaw.toString();
  const sku = (row.SKU || row.sku || '').toString() || undefined;
  const barcode = (row.Barcode || row.barcode || '').toString() || undefined;
  const variantData = { price, sku, barcode };

  const handle = (row.Handle || row.handle || '').toString() || undefined;
  const shopifyId = (row.ShopifyID || row.shopifyId || row.shopifyID || '').toString() || undefined;

  return { productInput, mediaInputs, variantData, handle, shopifyId };
}

/* ---------------- GraphQL  ---------------- */

async function createProduct(productInput, mediaInputs = []) {
  const mutation = `
    mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product { id handle title variants(first:1){ nodes{ id } } }
        userErrors { field message }
      }
    }
  `;
  const variables = { product: productInput };
  if (mediaInputs && mediaInputs.length) variables.media = mediaInputs;
  const data = await shopifyGraphql(mutation, variables);
  return data.productCreate || data;
}

async function updateProduct(productId, productInput) {
  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id handle }
        userErrors { field message }
      }
    }
  `;
  const input = { id: productId, ...productInput };
  delete input.variants;
  delete input.images;
  const data = await shopifyGraphql(mutation, { input });
  return data.productUpdate || data;
}

async function addMediaToProduct(productId, mediaInputs = []) {
  if (!productId || !Array.isArray(mediaInputs) || mediaInputs.length === 0) return { ok: true };
  const mutation = `
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { ... on MediaImage { id image { url } } ... on Model3d { id } }
        userErrors { field message }
      }
    }
  `;
  const variables = { productId, media: mediaInputs };
  const data = await shopifyGraphql(mutation, variables);
  return data.productCreateMedia || data;
}

async function updateVariantsBulk(productId, variantsArray = []) {
  if (!productId || !Array.isArray(variantsArray) || variantsArray.length === 0) return { ok: true };
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product { id }
        productVariants { id title price sku barcode }
        userErrors { field message }
      }
    }
  `;
  const variables = { productId, variants: variantsArray };
  const data = await shopifyGraphql(mutation, variables);
  return data.productVariantsBulkUpdate || data;
}

async function getFirstVariantId(productId) {
  const query = `
    query getFirstVariant($id: ID!) {
      node(id: $id) { ... on Product { variants(first:1) { nodes { id } } } }
    }
  `;
  const data = await shopifyGraphql(query, { id: productId });
  const node = data && data.node;
  return node?.variants?.nodes?.[0]?.id || null;
}


function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function main() {
  const filePath = process.argv[2] || process.env.XLSX_FILE;
  if (!filePath) {
    console.error('Usage: node index.js path/to/products.xlsx');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    process.exit(1);
  }

  const rows = parseSheet(filePath);
  console.log(`Found ${rows.length} row(s). Starting...`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const titleDisplay = row.Title || row.title || '(no title)';
    console.log(`\nRow ${i + 1}: ${titleDisplay}`);

    const built = buildInputsFromRow(row);
    if (!built) {
      console.warn('  Skipping row — Title required.');
      continue;
    }
    const { productInput, mediaInputs, variantData, handle, shopifyId: sheetShopifyId } = built;

    let productId = sheetShopifyId || null;
    try {
      if (!productId && handle) {
        const lookupQ = `
          query productByHandle($handle: String!) { productByHandle(handle: $handle) { id } }
        `;
        const lookup = await shopifyGraphql(lookupQ, { handle });
        productId = lookup?.productByHandle?.id || null;
        if (productId) console.log('  Found existing product id:', productId);
        else console.log('  No product found for handle — will create new.');
      }

      if (productId) {
        console.log('  Updating product:', productId);
        const up = await updateProduct(productId, productInput);
        if (up && up.userErrors && up.userErrors.length) {
          console.error('  productUpdate userErrors:', JSON.stringify(up.userErrors, null, 2));
        } else {
          console.log('  Product updated (handle):', up?.product?.handle || 'unknown');
        }

        if (mediaInputs && mediaInputs.length) {
          const addMediaResult = await addMediaToProduct(productId, mediaInputs);
          if (addMediaResult && addMediaResult.userErrors && addMediaResult.userErrors.length) {
            console.error('  addMedia userErrors:', JSON.stringify(addMediaResult.userErrors, null, 2));
          } else {
            console.log('  Media added for product.');
          }
        }

        const variantId = await getFirstVariantId(productId);
        if (variantId) {
          const variantPayload = {
            id: variantId,
            ...(variantData.price ? { price: variantData.price.toString() } : {}),
            ...(variantData.barcode ? { barcode: variantData.barcode } : {}),
            ...(variantData.sku ? { inventoryItem: { sku: variantData.sku } } : {}),
          };
          const vres = await updateVariantsBulk(productId, [variantPayload]);
          if (vres && vres.userErrors && vres.userErrors.length) {
            console.error('  variant bulk userErrors:', JSON.stringify(vres.userErrors, null, 2));
          } else {
            console.log('  Variant(s) bulk-updated.');
          }
        } else {
          console.warn('  No variant found to update.');
        }
      } else {
        console.log('  Creating product...');
        if (handle) productInput.handle = handle;
        const createResult = await createProduct(productInput, mediaInputs);
        if (createResult && createResult.userErrors && createResult.userErrors.length) {
          console.error('  productCreate userErrors:', JSON.stringify(createResult.userErrors, null, 2));
        } else {
          const createdProduct = createResult.product;
          const createdId = createdProduct?.id;
          console.log('  Created product id:', createdId);

          const firstVariant = createdProduct?.variants?.nodes?.[0];
          if (firstVariant && firstVariant.id) {
            const variantPayload = {
              id: firstVariant.id,
              ...(variantData.price ? { price: variantData.price.toString() } : {}),
              ...(variantData.barcode ? { barcode: variantData.barcode } : {}),
              ...(variantData.sku ? { inventoryItem: { sku: variantData.sku } } : {}),
            };
            const vres = await updateVariantsBulk(createdId, [variantPayload]);
            if (vres && vres.userErrors && vres.userErrors.length) {
              console.error('  variant bulk userErrors:', JSON.stringify(vres.userErrors, null, 2));
            } else {
              console.log('  Variant(s) bulk-updated.');
            }
          } else {
            console.warn('  No initial variant returned to update.');
          }
        }
      }

      await sleep(700);
    } catch (err) {
      console.error('  Error processing row:', err.response?.data || err.message || err);
      await sleep(2000);
    }
  }

  console.log('\nAll done.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
