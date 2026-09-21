-- Job IDs split by source: A-00001.. for CI/CD, M-00001.. for manual
-- `thub run` from a developer's own machine (jobs.js's nextJobId). The
-- original 'job_id' counter is now unused — left in place, harmless.
INSERT INTO counters (name, value) VALUES ('job_id_a', 0);
INSERT INTO counters (name, value) VALUES ('job_id_m', 0);
