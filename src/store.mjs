// Local-first persistence. Everything lives on the operator's own disk under a
// home dir; nothing leaves the machine. State is plain JSON; artifacts (raw run
// logs the benchmark measures) are separate files so they can be re-hashed during
// reverify. Writes are atomic (tmp file + rename) so a crash can't corrupt state.
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSafeId, safeId } from './util.mjs';

export function createStore(homeDir) {
  const runsRoot = resolve(homeDir, 'runs');
  const loopsRoot = resolve(homeDir, 'custom-loops');

  function assertWithin(base, target, label) {
    const rel = relative(base, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`${label} escaped the super-loop home`);
    }
  }

  function runDir(runId) {
    const target = resolve(runsRoot, safeId(runId, 'runId'));
    assertWithin(runsRoot, target, 'runId');
    return target;
  }
  function statePath(runId) {
    return join(runDir(runId), 'state.json');
  }
  function artifactsDir(runId) {
    return join(runDir(runId), 'artifacts');
  }
  function artifactPath(runId, artifactId) {
    return join(artifactsDir(runId), `${safeId(artifactId, 'artifactId')}.json`);
  }
  function runFilePath(runId, relPath) {
    const relPathString = String(relPath || '');
    if (!relPathString || relPathString.includes('\0') || isAbsolute(relPathString)) {
      throw new Error('run file path must be a relative path inside the run directory');
    }
    const base = runDir(runId);
    const full = resolve(base, relPathString);
    assertWithin(base, full, 'run file path');
    return full;
  }

  function atomicWrite(path, contents) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  }

  return {
    homeDir,
    runDir,

    exists(runId) {
      return existsSync(statePath(runId));
    },

    save(state) {
      mkdirSync(runDir(state.runId), { recursive: true });
      mkdirSync(artifactsDir(state.runId), { recursive: true });
      atomicWrite(statePath(state.runId), JSON.stringify(state, null, 2));
      return state;
    },

    load(runId) {
      if (!this.exists(runId)) return null;
      return JSON.parse(readFileSync(statePath(runId), 'utf8'));
    },

    listRuns() {
      if (!existsSync(runsRoot)) return [];
      return readdirSync(runsRoot).filter((name) => isSafeId(name) && existsSync(statePath(name)));
    },

    /** Persist a raw artifact (run log, baseline copy, measurement record). */
    writeArtifact(runId, artifactId, record) {
      mkdirSync(artifactsDir(runId), { recursive: true });
      atomicWrite(artifactPath(runId, artifactId), JSON.stringify(record, null, 2));
      return artifactId;
    },

    readArtifact(runId, artifactId) {
      const path = artifactPath(runId, artifactId);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },

    /** Write a human-facing file (dashboard.html / report.md) into the run dir. */
    writeRunFile(runId, relPath, contents) {
      mkdirSync(runDir(runId), { recursive: true });
      const full = runFilePath(runId, relPath);
      mkdirSync(dirname(full), { recursive: true });
      atomicWrite(full, contents);
      return full;
    },

    // ---- custom local loop library (user-added loops) ----------------------
    // Lives under <home>/custom-loops, separate from runs. The mandated, bundled
    // loops are NEVER stored here — they stay hash-locked in src/loops + constants.
    loopPath(loopId) {
      const target = resolve(loopsRoot, `${safeId(loopId, 'loopId')}.json`);
      assertWithin(loopsRoot, target, 'loopId');
      return target;
    },
    loopExists(loopId) {
      return existsSync(this.loopPath(loopId));
    },
    writeLoop(record) {
      mkdirSync(loopsRoot, { recursive: true });
      atomicWrite(this.loopPath(record.id), JSON.stringify(record, null, 2));
      return record.id;
    },
    readLoop(loopId) {
      if (!isSafeId(loopId)) return null;
      const path = this.loopPath(loopId);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    listLoops() {
      if (!existsSync(loopsRoot)) return [];
      return readdirSync(loopsRoot)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .filter((id) => isSafeId(id));
    }
  };
}
