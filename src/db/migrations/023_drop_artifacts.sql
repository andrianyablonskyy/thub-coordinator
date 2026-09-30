-- Job artifacts are no longer uploaded to or stored on the Coordinator
-- (README §9): Clients keep a job's files only in its workspace, which they
-- delete when the job ends. server.js removes <dataDir>/artifacts on startup.
DROP TABLE IF EXISTS artifacts;
