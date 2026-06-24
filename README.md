# Product Browser

Backend for browsing ~200,000 products, newest first, with category filtering
and pagination that stays correct and fast while the underlying data changes.

## The core decision: keyset (cursor) pagination, not OFFSET

The brief has two requirements that are actually the same underlying problem:

1. Pagination must be fast.
2. The result set must stay correct while products are being added/updated —
   no duplicates, no skipped items.

The natural first approach, `LIMIT 20 OFFSET 100000`, fails both:

- **Speed**: Postgres has to walk and discard the first 100,000 matching rows
  before it can return your 20. This gets linearly worse the deeper you page.
- **Correctness under writes**: OFFSET identifies a page by *position*. If
  "newest first" is `created_at DESC` and 50 new rows are inserted while a
  user is on page 6, every existing row's position shifts down by 50. The
  user's next "page 7" request now returns rows they already saw (or skips
  rows entirely), because the page boundary moved out from under them.

**The fix is keyset pagination.** Instead of asking for "rows 100,000–100,019",
the client asks for "the 20 rows that come after the last one I saw", where
"last one I saw" is identified by that row's own sort key — not its position:

```sql
SELECT * FROM products
WHERE category = $1
  AND (created_at, id) < ($cursor_created_at, $cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

`id` is included as a tiebreaker because bulk-inserted rows can share the same
`created_at` down to the millisecond; `(created_at, id)` together is always
unique and always strictly ordered.

**Why this is correct under concurrent writes:** the cursor is a *value*, not
a count. A row inserted anywhere, at any time, will compare against existing
cursor values in a single deterministic way: either it sorts before the
cursor (already "passed" — irrelevant to what the user does next) or after
it (it'll show up in a future page, in its rightful place). It can never cause
an already-returned row to reappear or an unseen row to be skipped, because
nothing about already-returned rows changes — they keep the same `(created_at,
id)` forever.

**Why I sort by `created_at`/`id` and never by `updated_at`:** these are set
once at insert time and never change. If pagination order depended on
`updated_at` instead, editing a product (e.g. changing its price) would make
it jump to the top of the "newest first" list mid-scroll — which is exactly
the kind of inconsistency the task warns against. A product being edited
should stay where it is in the list; only newly *created* products should
appear at the top.

**Why it's fast:** with a composite index `(category, created_at DESC, id
DESC)`, the `WHERE category = ... AND (created_at, id) < ...` + `ORDER BY`
is answered by a single index range scan — no sort step, no scanning past
discarded rows. Verified locally with `EXPLAIN ANALYZE` on 200k rows:

| Approach              | Page 1 | Page ~5000 (deep) |
|------------------------|--------|-------------------|
| Keyset (this repo)     | 0.3ms  | 0.3ms             |
| OFFSET (naive)         | ~1ms   | ~20ms (and rising)|

The keyset query plan is flat regardless of depth (an index scan that stops
as soon as it has 20 rows); the OFFSET plan does a bitmap scan + sort over
every matching row up to the offset, every time.

One accepted trade-off: keyset pagination doesn't support "jump to page 47"
arbitrarily — you can only go forward from a cursor (or restart from the
top). For an infinite-scroll / "load more" browsing UI, that's exactly the
access pattern needed, and it's the same approach used by most production
feeds (Twitter, GitHub's REST API pagination, Slack's API, etc).

## Schema

```sql
products (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT,
  category    TEXT,
  price       NUMERIC(10,2),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
)
```

Indexes:
- `(category, created_at DESC, id DESC)` — for filtered + sorted pagination
- `(created_at DESC, id DESC)` — for the unfiltered "All categories" case

## Seeding 200,000 rows fast

`seed.js` does **one** `INSERT ... SELECT ... FROM generate_series(1, 200000)`
statement, generated and run entirely inside Postgres. No per-row round trips
from the app. Locally this inserts all 200,000 rows in ~2.5 seconds.

```bash
DATABASE_URL=postgres://... node seed.js
```

To simulate the "50 products added while someone is browsing" scenario:

```bash
DATABASE_URL=postgres://... node seed.js --extra=50
```

## Running locally

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL
node seed.js
npm start               # http://localhost:3000
```

## API

`GET /api/products?category=Books&limit=20&cursor=<opaque>`
- `category` optional; omit or `All` for no filter
- `limit` default 20, max 100
- `cursor` opaque string from the previous response's `nextCursor`; omit for
  the first page
- Returns `{ data: [...], nextCursor: string|null, count: number }`

`GET /api/categories` — list of distinct categories for a filter dropdown.

## Deploying for free

**Database (Neon):**
1. Create a free project at neon.tech, copy the connection string.
2. Run `schema.sql` against it (or just run `node seed.js` once locally
   pointed at it — it creates the schema itself before seeding).

**Backend (Render):**
1. Push this repo to GitHub.
2. New Web Service on Render → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add env var `DATABASE_URL` pointing at your Neon connection string.

## What I'd improve with more time

- **Total counts**: I deliberately did not return a total result count
  (`SELECT count(*) ... WHERE category = ...`) alongside paginated results,
  because an accurate `COUNT(*)` over a filtered set is itself a full index
  scan and would undermine the "fast" requirement, and the count is also
  constantly changing while it's being computed — so it's its own version of
  the same consistency problem. If a total/approximate count were required
  I'd maintain it incrementally (e.g. a per-category counter updated in the
  same transaction as inserts) rather than computing it per request.
- **Cursor validation**: currently a malformed cursor returns 400; I'd add
  a signature (HMAC) on the cursor so a client can't construct an arbitrary
  one, though for this use case (read-only browsing) the impact of a forged
  cursor is minimal.
- **Connection pooling tuning** and read replicas if this needed to scale
  well past 200k rows / high concurrent read load.
- **Price/category-range filters** would need additional composite indexes
  matched to the actual filter combinations used.

## How I used AI

I used AI to scaffold boilerplate (Express routes, the static UI, the
seed script's SQL templating) faster than typing it by hand, and to sanity-
check the `EXPLAIN ANALYZE` output. The pagination *strategy* — keyset vs.
OFFSET, why `updated_at` can't be the sort key, the tiebreaker reasoning, and
the index design — is the part of this task that actually required
understanding, and I made sure I could explain and verify each piece (the
EXPLAIN ANALYZE comparison and the concurrent-insert test in the AI chat were
run against a real local Postgres instance to confirm the behavior, not taken
on faith).
