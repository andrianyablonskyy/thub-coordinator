'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// §3.1 / §12: stores uploaded result files under artifacts/<jobId>/ and
// generates HMAC-signed, time-limited download links (no server-side
// session needed for the Agent/CI to fetch them).
function createArtifactsService(db, { config }) {
  const secret = config.sessionSecret;

  function jobDir(jobId) {
    const dir = path.join(config.artifactsDir, jobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  }

  // `files` are multer file objects already written to a temp path.
  function storeUploaded(jobId, files) {
    const dir = jobDir(jobId);
    const stored = [];
    for (const file of files) {
      const dest = path.join(dir, path.basename(file.originalname));
      fs.renameSync(file.path, dest);
      const sha256 = sha256File(dest);
      const size = fs.statSync(dest).size;
      const info = db
        .prepare(
          `INSERT INTO artifacts (job_id, name, path, size, sha256, content_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(jobId, file.originalname, dest, size, sha256, file.mimetype, new Date().toISOString());
      stored.push(get(info.lastInsertRowid));
    }
    return stored;
  }

  function storeGenerated(jobId, name, buffer, contentType) {
    const dir = jobDir(jobId);
    const dest = path.join(dir, name);
    fs.writeFileSync(dest, buffer);
    const info = db
      .prepare(
        `INSERT INTO artifacts (job_id, name, path, size, sha256, content_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(jobId, name, dest, buffer.length, sha256File(dest), contentType, new Date().toISOString());
    return get(info.lastInsertRowid);
  }

  function get(id) {
    return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
  }

  function listForJob(jobId) {
    return db.prepare('SELECT * FROM artifacts WHERE job_id = ? ORDER BY id ASC').all(jobId);
  }

  function sign(artifactId, ttlHours = config.artifacts.linkTtlHours) {
    const expiresAt = Date.now() + ttlHours * 3600 * 1000;
    const payload = `${artifactId}.${expiresAt}`;
    const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  function verify(token) {
    const [artifactId, expiresAt, mac] = String(token).split('.');
    if (!artifactId || !expiresAt || !mac) throw invalidLink();
    const payload = `${artifactId}.${expiresAt}`;
    const expectedMac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expectedMac))) throw invalidLink();
    if (Date.now() > Number(expiresAt)) throw invalidLink('Link expired');
    const artifact = get(Number(artifactId));
    if (!artifact) throw invalidLink();
    return artifact;
  }

  function invalidLink(message = 'Invalid or expired link') {
    return Object.assign(new Error(message), { status: 403 });
  }

  function signedUrl(artifact) {
    return `${config.publicUrl}/artifacts/download/${sign(artifact.id)}`;
  }

  // Removes a job's artifact files from disk (not the DB rows — the
  // caller, jobs.js's cleanHistory, deletes those as part of the same
  // transaction that also deletes the job itself).
  function deleteJobArtifacts(jobId) {
    fs.rmSync(path.join(config.artifactsDir, jobId), { recursive: true, force: true });
  }

  function purgeOlderThan(days) {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const stale = db
      .prepare(
        `SELECT a.* FROM artifacts a JOIN jobs j ON j.id = a.job_id
         WHERE j.finished_at IS NOT NULL AND j.finished_at <= ?`
      )
      .all(cutoff);
    for (const artifact of stale) {
      fs.rmSync(artifact.path, { force: true });
      db.prepare('DELETE FROM artifacts WHERE id = ?').run(artifact.id);
    }
  }

  return {
    storeUploaded,
    storeGenerated,
    get,
    listForJob,
    sign,
    verify,
    signedUrl,
    purgeOlderThan,
    deleteJobArtifacts,
    jobDir,
  };
}

module.exports = { createArtifactsService };
