# Shopify Excel Product Importer (Node.js)

A simple Node.js command-line script that reads an Excel (`.xlsx`) file and creates or updates products in a Shopify store using the Admin GraphQL API.

## Features
- Create new products
- Update existing products (by Handle or ShopifyID)
- Update product fields: title, description, type, vendor, tags
- Update variant fields: price, barcode, SKU (via inventoryItem)
- Add one metafield per row
- Excel-based import workflow

## Requirements
- Node.js 16+
- Shopify store
- Custom/private Shopify app
- API scopes required:
  - write_products
  - read_products
  - write_inventory

## Setup
1. Run: `npm install axios dotenv xlsx`
2. Create `.env` file:
```
SHOPIFY_STORE=your-store-prefix
SHOPIFY_ADMIN_TOKEN=shpat_xxxxx
SHOPIFY_API_VERSION=2024-10
```

## Excel Format
Recommended columns:
- Title (required)
- Handle
- BodyHtml
- ProductType
- Vendor
- Tags
- Price
- SKU
- Barcode
- MetafieldNS
- MetafieldKey
- MetafieldValue
- MetafieldType

## Usage
Run:
```
node index.js products.xlsx
```

## How It Works
- Reads Excel
- Finds product by ShopifyID or handle
- Creates or updates product
- Updates variant using bulk variant API
- Adds metafield if provided

## Troubleshooting
- Ensure correct store prefix in .env
- Ensure product is Active and available in Online Store
- Ensure API scopes are correct

## License
MIT
