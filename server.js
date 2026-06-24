// server.js
//
// Two endpoints:
//   GET /api/products?category=Books&limit=20&cursor=<opaque>
//   GET /api/categories
//
// Pagination strategy: keyset / cursor-based, NOT OFFSET-based.
//
// The cursor encodes the (created_at, id) of the last row the client saw.
// Each request asks for rows strictly "after" that point in the sort order,
// using the same composite index that defines the order. This means:
//   - Speed: every page is an index range scan, regardless of how deep you
//     page. No scanning-and-discarding rows like OFFSET does.
//   - Correctness under concurrent writes: a row's position in the result
//     set is defined by its own (created_at, id), which never changes once
//     inserted. New inserts or edits elsewhere in the table can't shift
//     already-fetched rows into view again or push unseen rows out of view,
//     because nothing is being identified by position/row-count.

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Cursor is just base64("<created_at_iso>|<id>"). It's opaque to the client
// on purpose -- the client shouldn't construct or guess at it, only pass back
// what the server gave it.
function encodeCursor(row) {
  return Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString('base64');
}

function decodeCursor(cursor) {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const [createdAt, id] = decoded.split('|');
    if (!createdAt || !id) return null;
    return { createdAt, id: parseInt(id, 10) };
  } catch {
    return null;
  }
}

app.get('/api/products', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
    const category = req.query.category && req.query.category !== 'All' ? req.query.category : null;
    const cursor = req.query.cursor ? decodeCursor(req.query.cursor) : null;

    if (req.query.cursor && !cursor) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }

    const params = [];
    const whereClauses = [];

    if (category) {
      params.push(category);
      whereClauses.push(`category = $${params.length}`);
    }

    if (cursor) {
      params.push(cursor.createdAt);
      params.push(cursor.id);
      // Row qualifies if it's strictly "older" in our sort order than the
      // cursor row: either an earlier created_at, OR the same created_at
      // with a smaller id (our tiebreaker for timestamp collisions).
      whereClauses.push(
        `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`
      );
    }

    params.push(limit);
    const limitParam = params.length;

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const query = `
      SELECT id, name, category, price, created_at, updated_at
      FROM products
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitParam};
    `;

    const { rows } = await pool.query(query, params);

    const nextCursor = rows.length === limit ? encodeCursor(rows[rows.length - 1]) : null;

    res.json({
      data: rows,
      nextCursor,
      count: rows.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    // DISTINCT category is cheap here because there are only ~10 distinct
    // values; if categories were high-cardinality we'd maintain a separate
    // small lookup table instead of scanning for distincts.
    const { rows } = await pool.query(
      'SELECT DISTINCT category FROM products ORDER BY category;'
    );
    res.json({ categories: rows.map(r => r.category) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
