import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVICE_ROLE_USES } from '../src/db/types';

/**
 * The register must match the code, and be checked rather than trusted.
 *
 * README §9.3 promises that every service-role bypass is written down in
 * docs/SERVICE_ROLE_USAGE.md. That promise broke quietly: the code grew to 19
 * reasons while the document still described 4, and nothing failed — the gap
 * was found by reading, which is exactly the review step the document exists
 * to support.
 *
 * A bypass that is undocumented is the one a reviewer cannot weigh, so the
 * promise is enforced here instead.
 */

const REGISTER = fileURLToPath(new URL('../../../docs/SERVICE_ROLE_USAGE.md', import.meta.url));

describe('docs/SERVICE_ROLE_USAGE.md tracks ServiceRoleUse', () => {
  it('documents every enumerated reason, and nothing that no longer exists', async () => {
    const register = await readFile(REGISTER, 'utf8');

    // Each reason gets its own section: "### `interest.send`".
    const documented = [...register.matchAll(/^### `([a-z_]+\.[a-z_]+)`$/gm)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );

    const undocumented = SERVICE_ROLE_USES.filter((use) => !documented.includes(use));
    expect(
      undocumented,
      'these bypass RLS with no entry in the register — add a section saying where, why, safety and scope',
    ).toEqual([]);

    const stale = documented.filter(
      (use) => !(SERVICE_ROLE_USES as readonly string[]).includes(use),
    );
    expect(stale, 'these are documented but no longer in ServiceRoleUse').toEqual([]);
  });

  it('gives each reason a justification, not just a heading', async () => {
    const register = await readFile(REGISTER, 'utf8');

    // Split on the section headings and keep the body that follows each.
    const sections = register.split(/^### `/m).slice(1);
    const thin = sections
      .map((section) => {
        const name = section.slice(0, section.indexOf('`'));
        return { name, hasWhy: /\*\*Why[^*]*:\*\*/.test(section) };
      })
      .filter((s) => !s.hasWhy)
      .map((s) => s.name);

    expect(thin, 'a reason without a **Why** is a note, not a justification').toEqual([]);
  });
});
