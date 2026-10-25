-- Scopes the quads primary key by world (worlds-cloudflare#60).
--
-- In a shared database quad_id is a hash of the quad alone, so with
-- `PRIMARY KEY (quad_id)` two worlds holding the same triple fight over one
-- row: the second world's INSERT OR REPLACE takes the row from the first.
-- This rebuilds `quads` with PRIMARY KEY (world_id, quad_id). Every existing
-- row keeps its owner; nothing is lost that was not already lost.
--
-- Run once, AFTER 0001-quads-derived-column.sql, against a world-scoped
-- database (one with quads.world_id). SQLite cannot change a primary key in
-- place, hence the rebuild. Running it twice is safe: the second run rebuilds
-- the same table. A database created by this version or later already has the
-- composite key and does not need it.
--
--   wrangler d1 execute <DB_NAME> --file migrations/0002-quads-world-scoped-key.sql
CREATE TABLE quads_scoped (
  quad_id TEXT NOT NULL,
  s TEXT NOT NULL,
  s_type TEXT NOT NULL,
  p TEXT NOT NULL,
  o TEXT NOT NULL,
  o_type TEXT NOT NULL,
  o_datatype TEXT,
  o_lang TEXT,
  g TEXT NOT NULL,
  g_type TEXT NOT NULL,
  derived INTEGER NOT NULL DEFAULT 0,
  world_id TEXT NOT NULL,
  PRIMARY KEY (world_id, quad_id)
);
INSERT INTO quads_scoped (quad_id, s, s_type, p, o, o_type, o_datatype, o_lang, g, g_type, derived, world_id)
  SELECT quad_id, s, s_type, p, o, o_type, o_datatype, o_lang, g, g_type, derived, world_id FROM quads;
DROP TABLE quads;
ALTER TABLE quads_scoped RENAME TO quads;
CREATE INDEX IF NOT EXISTS idx_quads_spog ON quads(s, p, o, g);
CREATE INDEX IF NOT EXISTS idx_quads_sopg ON quads(s, o, p, g);
CREATE INDEX IF NOT EXISTS idx_quads_pso ON quads(p, s, o);
CREATE INDEX IF NOT EXISTS idx_quads_pos ON quads(p, o, s);
CREATE INDEX IF NOT EXISTS idx_quads_ospg ON quads(o, s, p, g);
CREATE INDEX IF NOT EXISTS idx_quads_opsg ON quads(o, p, s, g);
CREATE INDEX IF NOT EXISTS idx_quads_gpso ON quads(g, p, s, o);
