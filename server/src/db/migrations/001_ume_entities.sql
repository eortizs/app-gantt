-- 001_ume_entities.sql — document store for umeJSON entities.
--
-- Hybrid persistence: the full document lives in `document` (jsonb, source
-- of truth); the promoted columns are maintained by the SERVER on every
-- write (single writer = no drift) so queries never have to crack the JSON
-- open. `revision` mirrors lifecycle.version and drives optimistic locking.

CREATE TABLE ume_entities (
  id             uuid PRIMARY KEY,          -- id del documento
  entity_name    text NOT NULL,             -- 'GanttPlan' | 'GanttChangeRequest' | ...
  document       jsonb NOT NULL,            -- umeJSON completo, fuente de verdad
  plan_entity_id uuid,                      -- promovido: relations[0].targetId / cr.planEntityId
  status         text NOT NULL,             -- promovido: state.current / cr.status
  revision       integer NOT NULL,          -- espejo de lifecycle.version (lock optimista)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE INDEX ume_doc_gin ON ume_entities USING gin (document jsonb_path_ops);
CREATE INDEX ume_cr_queue ON ume_entities (plan_entity_id, created_at)
  WHERE entity_name = 'GanttChangeRequest' AND status = 'proposed';
