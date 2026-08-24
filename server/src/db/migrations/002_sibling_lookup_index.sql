-- 002_sibling_lookup_index.sql — covering indexes for the hot read paths.
--
-- getLatestForPlan resolves a plan's budget/actuals sibling by
-- (plan_entity_id, entity_name) ordered by updated_at; the only prior
-- index was the GanttChangeRequest partial. The health probe reads
-- MAX(revision) on every call.

CREATE INDEX ume_sibling_lookup ON ume_entities (plan_entity_id, entity_name, updated_at DESC)
  WHERE deleted_at IS NULL AND plan_entity_id IS NOT NULL;

CREATE INDEX ume_revision ON ume_entities (revision);
