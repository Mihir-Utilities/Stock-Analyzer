-- +goose Up
-- Source: docs/02-database.sql (split by T02; never edit once applied)

-- Foreign keys to import_batch added after all tables exist (keeps ordering simple)
ALTER TABLE fundamental_value ADD CONSTRAINT fundamental_value_batch_fk FOREIGN KEY (import_batch_id) REFERENCES import_batch(id) ON DELETE SET NULL;
ALTER TABLE shareholding      ADD CONSTRAINT shareholding_batch_fk      FOREIGN KEY (import_batch_id) REFERENCES import_batch(id) ON DELETE SET NULL;
ALTER TABLE corporate_action  ADD CONSTRAINT corporate_action_batch_fk  FOREIGN KEY (import_batch_id) REFERENCES import_batch(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE corporate_action DROP CONSTRAINT IF EXISTS corporate_action_batch_fk;
ALTER TABLE shareholding DROP CONSTRAINT IF EXISTS shareholding_batch_fk;
ALTER TABLE fundamental_value DROP CONSTRAINT IF EXISTS fundamental_value_batch_fk;
