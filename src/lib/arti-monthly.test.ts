// The monthly Arti routine (Tor design §6.6): .github/workflows/arti-monthly.yml
// with scripts/arti-monthly.mjs. It reports a new arti-client and whether
// the vendored saturating-time fix is still needed; it never changes the
// repository.
import { describe, expect, it } from 'vitest';
import workflow from '../../.github/workflows/arti-monthly.yml?raw';
import rootManifest from '../../Cargo.toml?raw';
import lock from '../../Cargo.lock?raw';
import vendoredManifest from '../../vendor/saturating-time/Cargo.toml?raw';
import {
  dropPatch,
  isNewer,
  lockedVersion,
  manifestVersion,
  report,
  stableVersion,
} from '../../scripts/arti-monthly.mjs';

const LOCK = `
[[package]]
name = "arti-client"
version = "0.47.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "saturating-time"
version = "0.5.0"
dependencies = [
 "web-time-compat",
]
`;

const CRATE = JSON.stringify({
  crate: { name: 'arti-client', max_version: '0.49.0-alpha.1', max_stable_version: '0.48.0' },
});

describe('reading versions', () => {
  it('finds a crate in Cargo.lock', () => {
    expect(lockedVersion(LOCK, 'arti-client')).toBe('0.47.0');
    expect(lockedVersion(LOCK, 'saturating-time')).toBe('0.5.0');
    expect(lockedVersion(LOCK, 'arti')).toBeNull();
  });

  it("finds the workspace's own arti-client and saturating-time", () => {
    expect(lockedVersion(lock, 'arti-client')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lockedVersion(lock, 'saturating-time')).toBe(manifestVersion(vendoredManifest));
  });

  it('takes the stable version from crates.io, not a pre-release', () => {
    expect(stableVersion(CRATE)).toBe('0.48.0');
    expect(() => stableVersion('{"errors":[{"detail":"Not Found"}]}')).toThrow();
  });

  it('compares versions by number', () => {
    expect(isNewer('0.48.0', '0.47.0')).toBe(true);
    expect(isNewer('0.47.10', '0.47.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.47.0', '0.47.0')).toBe(false);
    expect(isNewer('0.46.3', '0.47.0')).toBe(false);
  });
});

describe('dropping the patch, in the runner only', () => {
  it('takes out only the saturating-time entry', () => {
    const dropped = dropPatch(rootManifest);
    expect(dropped).not.toContain('vendor/saturating-time');
    expect(dropped).toContain('[patch.crates-io]');
    expect(rootManifest.split('\n').length - dropped.split('\n').length).toBe(1);
  });

  it('says so when there is no patch to drop', () => {
    expect(() => dropPatch('[workspace]\nmembers = []\n')).toThrow(/no saturating-time patch/);
  });
});

describe('the report', () => {
  const base = {
    arti: { current: '0.47.0', latest: '0.47.0' },
    saturating: { vendored: '0.5.0', latest: '0.5.0', unpatched: '0.5.0' },
    smoke: 'failure',
  };

  it('asks for nothing when Arti is current and the patch still needed', () => {
    const r = report(base);
    expect(r.attention).toBe(false);
    expect(r.markdown).toContain('still needed');
  });

  it('asks for the monthly update when there is a new arti-client', () => {
    const r = report({ ...base, arti: { current: '0.47.0', latest: '0.48.0' } });
    expect(r.attention).toBe(true);
    expect(r.markdown).toContain('0.48.0');
    expect(r.markdown).toContain('cargo upgrade');
  });

  it('says the patch can go when Arti starts on Windows without it', () => {
    const r = report({
      ...base,
      saturating: { vendored: '0.5.0', latest: '0.5.1', unpatched: '0.5.1' },
      smoke: 'success',
    });
    expect(r.attention).toBe(true);
    expect(r.markdown).toContain('no longer needed');
    expect(r.markdown).toContain('vendor/README.md');
  });

  it('flags a newer saturating-time even if this Arti cannot take it yet', () => {
    const r = report({
      ...base,
      saturating: { vendored: '0.5.0', latest: '0.6.0', unpatched: '0.5.0' },
    });
    expect(r.attention).toBe(true);
    expect(r.markdown).toContain('0.6.0');
  });

  it('says when the Windows check did not run', () => {
    const r = report({ ...base, smoke: '' });
    expect(r.attention).toBe(true);
    expect(r.markdown).toContain('did not run');
  });

  it('never claims a version it did not get', () => {
    const r = report({ ...base, arti: { current: '0.47.0', latest: '' } });
    expect(r.attention).toBe(true);
    expect(r.markdown).toContain('could not read');
  });
});

describe('the workflow', () => {
  it('runs once a month and by hand', () => {
    // A comment may sit between `schedule:` and its cron line.
    expect(workflow).toMatch(/schedule:\s*\n(\s*#.*\n)*\s*- cron: "\d+ \d+ \d+ \* \*"/);
    expect(workflow).toContain('workflow_dispatch:');
  });

  it('only reads: it can never push, open or merge anything', () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(workflow).not.toMatch(/:\s*write/);
    for (const forbidden of ['git push', 'git commit', 'git merge', 'GITHUB_TOKEN', 'secrets.']) {
      expect(workflow).not.toContain(forbidden);
    }
    // No GitHub CLI at all: no pull request, issue or merge.
    expect(workflow).not.toMatch(/\bgh\s/);
  });

  it('checks the patch on Windows, without committing the change', () => {
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('node scripts/arti-monthly.mjs drop-patch');
    expect(workflow).toContain('--test arti_windows_smoke');
  });
});
