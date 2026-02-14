-- job_fabrikation: Nenngeschwindigkeit, DMS Nr., Material, Position
-- Auf der FSM-Datenbank (Dispo) ausführen. Einmalig pro Datenbank.

ALTER TABLE job_fabrikation ADD COLUMN nenngeschwindigkeit VARCHAR(100) DEFAULT NULL AFTER leistung;
ALTER TABLE job_fabrikation ADD COLUMN dms_nr              VARCHAR(100) DEFAULT NULL AFTER kraftaufnehmer;
ALTER TABLE job_fabrikation ADD COLUMN material            VARCHAR(100) DEFAULT NULL AFTER elektronik;
ALTER TABLE job_fabrikation ADD COLUMN position            VARCHAR(100) DEFAULT NULL AFTER material;
