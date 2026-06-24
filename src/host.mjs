// Host capability preflight. Answers "which frontier-agent CLIs are actually
// installed on this machine" so the model can pick real routes instead of naming
// models it can't drive. The hard rule: this NEVER executes anything. It resolves
// known binary names against PATH with a filesystem stat only — no spawn, no
// `--version`, no shell. Presence on PATH is reported honestly as presence on
// PATH, NOT as proof the CLI is authenticated/working, and NOT as web/SOTA
// research. An MCP cannot prove a CLI works without running it; we do not pretend.
import { accessSync, statSync, constants as FS } from 'node:fs';
import { join, delimiter } from 'node:path';

// Fixed allowlist of known frontier-agent CLIs. Hardcoded on purpose: the MCP
// only ever looks for THESE names, never a model-supplied command, so there is no
// path by which a model can have the MCP probe for arbitrary executables.
export const KNOWN_ROUTE_CLIS = [
  { name: 'claude', provider: 'Anthropic', note: 'Claude Code / claude CLI (Opus/Sonnet)' },
  { name: 'codex', provider: 'OpenAI', note: 'Codex CLI (GPT-5.x frontier)' },
  { name: 'gemini', provider: 'Google', note: 'Gemini CLI' },
  { name: 'opencode', provider: 'open-source', note: 'OpenCode agent CLI' },
  { name: 'glm', provider: 'Z.ai', note: 'optional GLM wrapper (GLM-5.x)' }
];

function isExecutableFile(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    accessSync(path, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a bare command name against PATH without executing it. */
export function resolveOnPath(name, pathValue, isWindows) {
  const dirs = String(pathValue || '').split(delimiter).filter(Boolean);
  const candidates = isWindows
    ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
    : [name];
  for (const dir of dirs) {
    for (const c of candidates) {
      const full = join(dir, c);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/**
 * Build a local capability report for the known frontier CLIs.
 * @param {{ env?: object, platform?: string }} [opts] injectable for tests
 */
export function detectHostCapabilities(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const isWindows = platform === 'win32';
  const routes = KNOWN_ROUTE_CLIS.map((cli) => {
    const path = resolveOnPath(cli.name, env.PATH || env.Path, isWindows);
    return { name: cli.name, provider: cli.provider, note: cli.note, installed: !!path, path: path || null };
  });
  const installed = routes.filter((r) => r.installed).map((r) => r.name);
  return {
    routes,
    installedCount: installed.length,
    installed,
    method: 'PATH presence (filesystem stat only; no command executed)',
    boundary: 'Presence on PATH is NOT proof the CLI is authenticated or functional, and is NOT web/SOTA research. Confirm auth out-of-band before relying on a route; web-search current SOTA separately.'
  };
}
