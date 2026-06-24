// seed.js
//
// Generates 200,000 products directly inside Postgres using generate_series(),
// instead of looping in JS and doing 200,000 round trips (which would take
// minutes and hammer the connection). This is one INSERT ... SELECT statement
// that runs entirely on the DB server in a couple of seconds.
//
// Usage:
//   DATABASE_URL=postgres://... node seed.js            -> wipes + inserts 200,000 products
//   DATABASE_URL=postgres://... node seed.js --extra=50  -> inserts 50 MORE fresh products
//                                                            (useful for testing pagination
//                                                            consistency while "live")

require('dotenv').config();
const { Pool } = require('pg');

const CATEGORIES = [
  'Electronics', 'Clothing', 'Home & Kitchen', 'Books', 'Toys & Games',
  'Sports & Outdoors', 'Beauty', 'Grocery', 'Automotive', 'Office Supplies',
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const extraArg = process.argv.find(a => a.startsWith('--extra='));
  const extraCount = extraArg ? parseInt(extraArg.split('=')[1], 10) : null;

  const client = await pool.connect();
  try {
    if (extraCount) {
      // Simulates new products arriving while someone is mid-scroll.
      console.log(`Inserting ${extraCount} new products (simulating live writes)...`);
      await client.query(
        `INSERT INTO products (name, category, price, created_at, updated_at)
         SELECT
           'New Product ' || g,
           (ARRAY[${CATEGORIES.map(c => `'${c}'`).join(',')}])[1 + floor(random() * ${CATEGORIES.length})],
           round((random() * 500 + 5)::numeric, 2),
           now(),
           now()
         FROM generate_series(1, $1) g;`,
        [extraCount]
      );
      console.log('Done.');
      return;
    }

    console.log('Creating schema (if not exists)...');
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);

    console.log('Clearing existing products...');
    await client.query('TRUNCATE TABLE products RESTART IDENTITY;');

    console.log('Inserting 200,000 products in one set-based statement...');
    const start = Date.now();

    await client.query(
      `INSERT INTO products (name, category, price, created_at, updated_at)
       SELECT
         'Product ' || g,
         (ARRAY[${CATEGORIES.map(c => `'${c}'`).join(',')}])[1 + floor(random() * ${CATEGORIES.length})],
         round((random() * 500 + 5)::numeric, 2),
         -- spread created_at over the last 365 days so "newest first" is meaningful
         now() - (random() * interval '365 days'),
         now() - (random() * interval '30 days')
       FROM generate_series(1, 200000) g;`
    );

    console.log(`Inserted 200,000 rows in ${Date.now() - start}ms`);

    const { rows } = await client.query('SELECT count(*) FROM products');
    console.log(`Total rows in table: ${rows[0].count}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
