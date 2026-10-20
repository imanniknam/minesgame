// One tiny interface over two drivers: real Postgres (prod, DATABASE_URL) or in-process PGlite (local dev/tests).
// db.query(sql, params) -> { rows }   db.tx(async q => ...) runs fn inside BEGIN/COMMIT with rollback on throw.
import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  balance       BIGINT NOT NULL CHECK (balance >= 0),
  last_bonus_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS games (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  bet        BIGINT NOT NULL CHECK (bet > 0),
  mines      INT[]  NOT NULL,
  revealed   INT[]  NOT NULL DEFAULT '{}',
  status     TEXT   NOT NULL CHECK (status IN ('active','busted','cashed')),
  mult_x100  INT    NOT NULL DEFAULT 0,
  payout     BIGINT NOT NULL DEFAULT 0,
  seed       TEXT   NOT NULL,
  seed_hash  TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at   TIMESTAMPTZ
);
-- the anti double-play guarantee: at most one active round per user, enforced by the DB itself
CREATE UNIQUE INDEX IF NOT EXISTS one_active_game ON games(user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS games_user_recent ON games(user_id, id DESC);
CREATE TABLE IF NOT EXISTS ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  game_id       BIGINT REFERENCES games(id),
  kind          TEXT   NOT NULL CHECK (kind IN ('signup','bet','win','bonus')),
  amount        BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id DESC);

-- v2 (game hub): additive only, so the Mines-only deploy keeps working on the same DB
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS game TEXT NOT NULL DEFAULT 'mines';
ALTER TABLE games ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}';
ALTER TABLE games ADD COLUMN IF NOT EXISTS rid TEXT;
ALTER TABLE games ALTER COLUMN mines DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS games_rid ON games(user_id, rid) WHERE rid IS NOT NULL;
CREATE INDEX IF NOT EXISTS games_user_game ON games(user_id, game, id DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_kind_check' AND pg_get_constraintdef(oid) LIKE '%referral%') THEN
    ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_kind_check;
    ALTER TABLE ledger ADD CONSTRAINT ledger_kind_check CHECK (kind IN ('signup','bet','win','bonus','referral'));
  END IF;
END $$;
`;

async function makePg(url) {
  const pool = new pg.Pool({ connectionString: url, max: 3, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  pg.types.setTypeParser(20, Number); // BIGINT -> number (cents stay far below 2^53)
  return {
    query: (sql, p) => pool.query(sql, p),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn((sql, p) => c.query(sql, p));
        await c.query('COMMIT');
        return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
    // DDL takes AccessExclusive locks; parallel cold starts running it next to live transactions deadlocked (40P01).
    // So: one migrator at a time (advisory lock on a dedicated connection).
    async exec(sql) {
      const c = await pool.connect();
      try { await c.query('SELECT pg_advisory_lock(727274)'); await c.query(sql); }
      finally { await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {}); c.release(); }
    },
  };
}

async function makePglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(process.env.PGLITE_DIR || undefined); // shortcut: in-memory unless PGLITE_DIR set; dev only
  const fix = r => ({ rows: r.rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))) });
  return {
    query: async (sql, p) => fix(await db.query(sql, p)),
    tx: fn => db.transaction(t => fn(async (sql, p) => fix(await t.query(sql, p)))),
    exec: sql => db.exec(sql),
  };
}

let ready;
export function getDb() {
  ready ??= (async () => {
    const db = process.env.DATABASE_URL ? await makePg(process.env.DATABASE_URL) : await makePglite();
    // fast path: schema already at the latest version -> run no DDL at all on this cold start
    const { rows: [v] } = await db.query(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='games' AND column_name='rid')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ledger_kind_check' AND pg_get_constraintdef(oid) LIKE '%referral%') AS current`);
    if (!v.current) await db.exec(SCHEMA);
    return db;
  })().catch(e => { ready = undefined; throw e; });
  return ready;
}
