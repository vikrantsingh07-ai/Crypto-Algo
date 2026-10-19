import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * deploy/oracle/update.sh against a LOCAL bare "origin" repository and a fake `docker` on the PATH. The real script
 * runs end to end (lock, local-change check, git pull --ff-only, compose up, health wait, scrubbed log tail); only
 * Docker itself is a stand-in. Nothing here was run on a real Oracle VM.
 */

const REPO = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO, 'deploy/oracle/update.sh');
const SECRET_ADMIN = 'Sup3rSecretPassw0rd-DoNotPrint';
const SECRET_PG = '0123456789abcdef0123456789abcdef0123456789abcdef';
const SECRET_PROXY = 'ProxySharedSecretValueThatMustNeverShowUp0123';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_TERMINAL_PROMPT: '0' };
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: cwd, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $* [cwd=$(basename "$(dirname "$(pwd)")")/$(basename "$(pwd)")]" >> "$FAKE_DOCKER_LOG"
[ "$1" = compose ] || exit 0
shift
case "$1" in
  version) exit 0 ;;
  up)
    if [ "\${FAKE_DOCKER_UP_FAIL:-0}" = 1 ]; then echo "ERROR: build failed (fake)" >&2; exit 1; fi
    exit 0 ;;
  exec)
    n=$(cat "$FAKE_DOCKER_STATE" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_DOCKER_STATE"
    [ "$n" -ge "\${FAKE_DOCKER_HEALTHY_AFTER:-1}" ] && exit 0
    exit 1 ;;
  logs)
    tail_n=100000
    while [ $# -gt 0 ]; do [ "$1" = --tail ] && tail_n="$2"; shift; done
    { for i in $(seq 1 60); do echo "server line $i"; done
      echo "boot: admin password is $(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-) and the db password is $(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
      echo "short value PROXY_SHARED_SECRET=$(grep '^PROXY_SHARED_SECRET=' .env | cut -d= -f2-)"; } | tail -n "$tail_n" ;;
esac
exit 0
`;

interface Fixture {
  root: string;
  app: string;
  pusher: string;
  bin: string;
  log: string;
  state: string;
  lock: string;
}

/** origin (bare) <- pusher (the developer's clone) and app (the VM's clone at APP_DIR), with a private .env in app. */
function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'cryptoalgo-update-'));
  roots.push(root);
  const origin = path.join(root, 'origin.git');
  const pusher = path.join(root, 'pusher');
  const app = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'init', '-b', 'main', pusher);
  cpSync(path.join(REPO, 'deploy/oracle'), path.join(pusher, 'deploy/oracle'), { recursive: true });
  rmSync(path.join(pusher, 'deploy/oracle/.env'), { force: true });
  writeFileSync(path.join(pusher, 'VERSION'), 'one\n');
  writeFileSync(path.join(pusher, '.gitignore'), '.env\nSTATUS.txt\n');
  git(pusher, 'add', '-A');
  git(pusher, 'commit', '-m', 'first version');
  git(pusher, 'remote', 'add', 'origin', origin);
  git(pusher, 'push', '-u', 'origin', 'main');
  git(root, 'clone', origin, app);
  writeFileSync(
    path.join(app, 'deploy/oracle/.env'),
    [`ADMIN_PASSWORD=${SECRET_ADMIN}`, `POSTGRES_PASSWORD=${SECRET_PG}`, `PROXY_SHARED_SECRET=${SECRET_PROXY}`, 'API_HOST=1-2-3-4.sslip.io', 'LIVE_HARD_DISABLE=false', ''].join('\n'),
    { mode: 0o600 },
  );

  const docker = path.join(bin, 'docker');
  writeFileSync(docker, FAKE_DOCKER);
  chmodSync(docker, 0o755);
  const realId = spawnSync('which', ['id'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/id';
  const id = path.join(bin, 'id');
  writeFileSync(id, `#!/bin/sh\nif [ "$1" = "-u" ]; then echo "\${FAKE_UID:-0}"; exit 0; fi\nexec ${realId} "$@"\n`);
  chmodSync(id, 0o755);
  return { root, app, pusher, bin, log: path.join(root, 'docker.log'), state: path.join(root, 'docker.state'), lock: path.join(root, 'update.lock') };
}

function run(f: Fixture, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${f.bin}:${process.env.PATH}`,
      HOME: f.root,
      ...GIT_ENV,
      APP_DIR: f.app,
      LOCK_FILE: f.lock,
      FAKE_DOCKER_LOG: f.log,
      FAKE_DOCKER_STATE: f.state,
      HEALTH_TIMEOUT: '10',
      HEALTH_INTERVAL: '1',
      ...env,
    },
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const dockerLog = (f: Fixture) => (existsSync(f.log) ? readFileSync(f.log, 'utf8') : '');
const head = (dir: string) => git(dir, 'rev-parse', 'HEAD');
function release(f: Fixture, text = 'two') {
  writeFileSync(path.join(f.pusher, 'VERSION'), `${text}\n`);
  git(f.pusher, 'commit', '-am', `release ${text}`);
  git(f.pusher, 'push', 'origin', 'main');
}
const noSecrets = (out: string) => {
  for (const s of [SECRET_ADMIN, SECRET_PG, SECRET_PROXY]) expect(out).not.toContain(s);
};

describe('deploy/oracle/update.sh (S5)', () => {
  it('is valid bash, executable, and only ever pulls fast-forward', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toMatch(/git.*pull --ff-only/);
    expect(text).toMatch(/docker compose up -d --build/);
    expect(text).not.toMatch(/reset --hard(?!.*\$before)|git.* clean|checkout -f|stash/); // the only hard reset is the one printed as advice to the operator
    expect(text).not.toMatch(/\becho\b[^\n]*\$\{?(ADMIN_PASSWORD|POSTGRES_PASSWORD|SESSION_SECRET|PROXY_SHARED_SECRET)/);
  });

  it('DRY_RUN with a clean tree: prints the plan and changes nothing (no pull, no docker)', () => {
    const f = fixture();
    release(f); // the remote is ahead; a dry run must not fetch or pull it
    const before = head(f.app);
    const r = run(f, { DRY_RUN: '1', FAKE_UID: '1000' }); // a dry run does not need root
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/DRY_RUN: the working tree is clean/);
    expect(r.out).toMatch(/git pull --ff-only; docker compose up -d --build/);
    expect(head(f.app)).toBe(before);
    expect(dockerLog(f)).toBe('');
    noSecrets(r.out);
  });

  it('refuses to continue when tracked files have local changes: lists the names, never the contents, resets nothing', () => {
    const f = fixture();
    const marker = 'LOCAL-EDIT-MARKER-4711';
    writeFileSync(path.join(f.app, 'VERSION'), `${marker}\n`);
    release(f);
    for (const env of [{ DRY_RUN: '1' }, {}] as Record<string, string>[]) {
      const r = run(f, env);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/local changes/);
      expect(r.out).toMatch(/VERSION/);
      expect(r.out).not.toContain(marker);
      expect(readFileSync(path.join(f.app, 'VERSION'), 'utf8')).toBe(`${marker}\n`); // the operator's edit is untouched
      expect(dockerLog(f)).not.toMatch(/ up | exec | logs /); // only the harmless "compose version" probe ran: nothing was rebuilt
    }
    expect(git(f.app, 'log', '-1', '--format=%s')).toBe('first version'); // nothing was pulled either
  });

  it('untracked and ignored files (.env, STATUS.txt, scratch files) do not block an update', () => {
    const f = fixture();
    writeFileSync(path.join(f.app, 'STATUS.txt'), 'status\n');
    writeFileSync(path.join(f.app, 'notes.tmp'), 'scratch\n');
    const r = run(f, { DRY_RUN: '1' });
    expect(r.status, r.out).toBe(0);
  });

  it('refuses early and clearly: not root, no checkout, no .env, bad timeout numbers', () => {
    const f = fixture();
    const notRoot = run(f, { FAKE_UID: '1000' });
    expect(notRoot.status).toBe(1);
    expect(notRoot.out).toMatch(/run as root/);
    expect(dockerLog(f)).toBe('');

    expect(run(f, { APP_DIR: path.join(f.root, 'nowhere') }).out).toMatch(/not a git checkout/);

    rmSync(path.join(f.app, 'deploy/oracle/.env'));
    const noEnv = run(f);
    expect(noEnv.status).toBe(1);
    expect(noEnv.out).toMatch(/\.env not found.*setup\.sh/);

    expect(run(f, { HEALTH_TIMEOUT: 'soon' }).out).toMatch(/must be whole numbers/);
    expect(dockerLog(f)).toBe('');
  });

  it('updates: pulls the new commit, rebuilds in deploy/oracle with the existing .env, waits for health and prints OK', () => {
    const f = fixture();
    release(f, 'two');
    const before = head(f.app);
    const r = run(f);
    expect(r.status, r.out).toBe(0);
    expect(head(f.app)).toBe(head(f.pusher));
    expect(head(f.app)).not.toBe(before);
    expect(r.out).toMatch(/updated [0-9a-f]+ -> [0-9a-f]+: release two/);
    expect(r.out).toMatch(/OK: the backend runs [0-9a-f]+ and is healthy/);
    const log = dockerLog(f).trim().split('\n');
    expect(log[0]).toMatch(/^docker compose version/);
    expect(log[1]).toBe('docker compose up -d --build [cwd=deploy/oracle]'); // no secrets and no --env-file on the command line
    expect(log[2]).toMatch(/^docker compose exec -T server node -e .*api\/health/);
    expect(log.some((l) => /--env|-e [A-Z_]+=|PASSWORD|SECRET/.test(l.replace(/node -e .*$/, '')))).toBe(false);
    noSecrets(r.out);
  });

  it('waits for a slow start: healthy only after several probes still ends in OK', () => {
    const f = fixture();
    release(f);
    const r = run(f, { FAKE_DOCKER_HEALTHY_AFTER: '3', HEALTH_TIMEOUT: '20' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/OK:/);
    expect(dockerLog(f).match(/ exec -T server/g)).toHaveLength(3);
  }, 30_000);

  it('is idempotent: running it again at the latest code rebuilds, stays healthy and changes no commit', () => {
    const f = fixture();
    const first = run(f);
    expect(first.status, first.out).toBe(0);
    const h1 = head(f.app);
    const second = run(f);
    expect(second.status, second.out).toBe(0);
    expect(second.out).toMatch(/already at the latest code/);
    expect(second.out).toMatch(/OK:/);
    expect(head(f.app)).toBe(h1);
  });

  it('NOT healthy: exits 1, says so, prints the last 40 log lines with every secret from .env hidden, and offers the way back', () => {
    const f = fixture();
    release(f);
    const before = head(f.app);
    const r = run(f, { FAKE_DOCKER_HEALTHY_AFTER: '9999', HEALTH_TIMEOUT: '2', HEALTH_INTERVAL: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/NOT healthy after 2s/);
    expect(dockerLog(f)).toMatch(/docker compose logs --no-color --tail 40 server/);
    const lines = r.out.split('\n').filter((l) => /^server line \d+$/.test(l));
    expect(lines).toHaveLength(38); // the fake emits 60 numbered lines + 2 secret-bearing lines; the last 40 are 23..60 + those two
    expect(lines[0]).toBe('server line 23');
    expect(lines.at(-1)).toBe('server line 60');
    expect(r.out).toMatch(/admin password is \*\*\* and the db password is \*\*\*/);
    expect(r.out).toMatch(/PROXY_SHARED_SECRET=\*\*\*/);
    noSecrets(r.out);
    expect(r.out).toContain(`reset --hard ${before}`); // the previous commit is named so the operator can go back
  }, 30_000);

  it('a failed build stops there: no health wait, the old version is named, no secret printed', () => {
    const f = fixture();
    release(f);
    const r = run(f, { FAKE_DOCKER_UP_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/docker compose up --build failed/);
    expect(dockerLog(f)).not.toMatch(/ exec -T server/);
    noSecrets(r.out);
  });

  it('a history that cannot be fast-forwarded stops before any rebuild and tells the operator', () => {
    const f = fixture();
    writeFileSync(path.join(f.app, 'LOCAL-ONLY'), 'x\n');
    git(f.app, 'add', 'LOCAL-ONLY');
    git(f.app, 'commit', '-m', 'local commit that is not on origin');
    release(f, 'two'); // origin moved on too: the histories diverge
    const r = run(f);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/git pull --ff-only failed/);
    expect(r.out).toMatch(/Nothing was rebuilt/);
    expect(dockerLog(f)).not.toMatch(/up -d --build/);
    expect(git(f.app, 'log', '-1', '--format=%s')).toBe('local commit that is not on origin'); // the local commit is kept
  });

  it('only one update at a time (flock)', () => {
    const hasFlock = spawnSync('bash', ['-c', 'command -v flock']).status === 0;
    if (!hasFlock) return; // util-linux is on every Ubuntu VM; skip on a machine without it
    const f = fixture();
    // (the trailing `exit $?` keeps the holder shell alive; without it bash would exec the last command and the lock would be handed over)
    const r = spawnSync('bash', ['-c', `exec 9>"${f.lock}"; flock -n 9 || exit 99; bash "${SCRIPT}"; exit $?`], {
      encoding: 'utf8',
      env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: f.root, APP_DIR: f.app, LOCK_FILE: f.lock, FAKE_DOCKER_LOG: f.log, FAKE_DOCKER_STATE: f.state },
    });
    expect(r.status).toBe(1);
    expect((r.stdout ?? '') + (r.stderr ?? '')).toMatch(/another update is already running/);
    expect(dockerLog(f)).not.toMatch(/up -d --build/);
  });
});
