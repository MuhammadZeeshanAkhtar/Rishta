import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import catalog from '../../../../packages/i18n/src/locales/en.json';
import { RestrictedAccountView, type RestrictedAccountViewProps } from './RestrictedAccountView';
import { RESTRICTED_STATUSES, restrictedContent, type RestrictedAction } from './restrictedContent';

/**
 * Review N7, the screen itself: the real view, the real English catalog, rendered
 * to markup, with the buttons pressed. React Native primitives are replaced by
 * plain elements because this suite has no native renderer. Nothing about the
 * wording, the buttons or their handlers is replaced.
 */

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children: ReactNode }) => createElement('p', null, children),
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../components/Screen', () => ({
  Screen: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement('main', null, createElement('h1', null, title), children),
}));
vi.mock('../components/Banner', () => ({
  Banner: ({ message }: { message: string }) => createElement('aside', null, message),
}));
vi.mock('../components/Button', () => ({
  Button: (props: { label: string; testID: string; disabled?: boolean; loading?: boolean }) =>
    createElement(
      'button',
      {
        'data-testid': props.testID,
        disabled: props.disabled ?? false,
        'data-loading': String(props.loading ?? false),
      },
      props.label,
    ),
}));
vi.mock('../theme/tokens', () => ({
  spacing: { sm: 1, md: 2 },
  typography: { body: {} },
}));

function lookup(key: string): string {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  if (typeof node !== 'string') throw new Error(`Missing catalog key: ${key}`);
  return node;
}

const props = (
  status: string,
  extra: Partial<RestrictedAccountViewProps> = {},
): RestrictedAccountViewProps => ({
  status,
  t: lookup,
  colors: { text: '#000', textMuted: '#555' },
  busy: null,
  error: null,
  onAction: () => {},
  ...extra,
});

const render = (status: string, extra: Partial<RestrictedAccountViewProps> = {}) =>
  renderToStaticMarkup(createElement(RestrictedAccountView, props(status, extra)));

/** The buttons in the rendered tree, with the handlers the view gave them. */
function buttonsOf(element: ReactNode): Array<{ testID: string; onPress: () => void }> {
  const found: Array<{ testID: string; onPress: () => void }> = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const el = node as ReactElement<{
      testID?: string;
      onPress?: () => void;
      children?: ReactNode;
    }>;
    if (el.props.testID && el.props.onPress) {
      found.push({ testID: el.props.testID, onPress: el.props.onPress });
    }
    walk(el.props.children);
  };
  walk(element);
  return found;
}

const actionsFor = (status: string) =>
  buttonsOf(RestrictedAccountView(props(status))).map((b) => b.testID);

describe('what each status says', () => {
  it.each([
    ['suspended', 'Your account is suspended'],
    ['banned', 'Your account is banned'],
    ['deactivated', 'Your account is deactivated'],
    ['pending_deletion', 'Your account is scheduled for deletion'],
  ])('%s names the actual state', (status, title) => {
    const html = render(status);
    expect(html).toContain(`<h1>${title}</h1>`);
    const content = restrictedContent(status);
    expect(html).toContain(lookup(content.explanationKey).replace(/'/g, '&#x27;'));
    expect(html).toContain(lookup(content.nextStepKey).replace(/'/g, '&#x27;'));
  });

  it('never mentions onboarding or asks them to finish a profile', () => {
    for (const status of RESTRICTED_STATUSES) {
      expect(render(status).toLowerCase()).not.toMatch(
        /onboarding|finish your profile|complete your profile/,
      );
    }
  });

  it('invents no appeal, deadline, reinstatement or reason', () => {
    for (const status of ['suspended', 'banned']) {
      const html = render(status).toLowerCase();
      expect(html).not.toMatch(
        /appeal|within \d|days|automatically|will be restored|because|contact/,
      );
    }
  });

  it('an unknown status gets cautious wording, not a blank screen', () => {
    expect(render('something_new')).toContain('<h1>Your account isn&#x27;t available</h1>');
    expect(render('')).toContain('<h1>Your account isn&#x27;t available</h1>');
    expect(render('constructor')).toContain('<h1>Your account isn&#x27;t available</h1>');
  });
});

describe('what each status offers', () => {
  it('suspended and banned can sign out or ask for deletion: no way to lift it themselves', () => {
    expect(actionsFor('suspended')).toEqual(['restricted-sign_out', 'restricted-request_deletion']);
    expect(actionsFor('banned')).toEqual(['restricted-sign_out', 'restricted-request_deletion']);
    expect(render('banned')).not.toMatch(/Reactivate|Keep my account/);
  });

  it('deactivated can reactivate, sign out, or ask for deletion', () => {
    expect(actionsFor('deactivated')).toEqual([
      'restricted-reactivate',
      'restricted-sign_out',
      'restricted-request_deletion',
    ]);
    expect(render('deactivated')).toContain('Reactivate my account');
  });

  it('pending deletion can keep the account, or sign out', () => {
    expect(actionsFor('pending_deletion')).toEqual([
      'restricted-cancel_deletion',
      'restricted-sign_out',
    ]);
    expect(render('pending_deletion')).toContain('Keep my account');
  });

  it('an unknown status can only sign out', () => {
    expect(actionsFor('something_new')).toEqual(['restricted-sign_out']);
  });
});

describe('pressing the buttons', () => {
  it.each<[string, RestrictedAction]>([
    ['deactivated', 'reactivate'],
    ['deactivated', 'sign_out'],
    ['pending_deletion', 'cancel_deletion'],
    ['pending_deletion', 'sign_out'],
    ['suspended', 'sign_out'],
    ['banned', 'sign_out'],
    ['suspended', 'request_deletion'],
    ['banned', 'request_deletion'],
    ['deactivated', 'request_deletion'],
  ])('%s: %s reports that action', (status, action) => {
    const onAction = vi.fn();
    const button = buttonsOf(RestrictedAccountView(props(status, { onAction }))).find(
      (b) => b.testID === `restricted-${action}`,
    );
    button!.onPress();
    expect(onAction).toHaveBeenCalledExactlyOnceWith(action);
  });
});

describe('an open deletion request', () => {
  it('shows the date when this session knows it', () => {
    const html = render('pending_deletion', {
      deletion: { scheduledOn: '6 December 2026', held: false },
    });
    expect(html).toContain('scheduled for deletion on 6 December 2026');
    expect(html).not.toContain('safety review');
  });

  it('says so when a safety review is holding it', () => {
    const html = render('pending_deletion', { deletion: { scheduledOn: null, held: true } });
    expect(html).toContain('A safety review on this account must finish');
  });

  it('after a restart nothing is known, and no date is guessed', () => {
    const html = render('pending_deletion', { deletion: { scheduledOn: null, held: false } });
    expect(html).not.toMatch(/scheduled for deletion on/);
    expect(html).toContain('Keep my account');
  });

  it('other statuses say nothing about it', () => {
    const html = render('suspended', { deletion: { scheduledOn: '6 December 2026', held: true } });
    expect(html).not.toContain('6 December 2026');
  });
});

describe('while an action is running, and when it fails', () => {
  it('the running button spins and the others wait', () => {
    const html = render('deactivated', { busy: 'reactivate' });
    expect(html).toMatch(/data-testid="restricted-reactivate"[^>]*data-loading="true"/);
    expect(html).toMatch(/data-testid="restricted-sign_out"[^>]*disabled/);
  });

  it('shows the failure, and still offers a way out', () => {
    const html = render('deactivated', { error: 'No connection.' });
    expect(html).toContain('<aside>No connection.</aside>');
    expect(html).toContain('Sign out');
  });
});

describe('the catalog', () => {
  it('has every string every status uses', () => {
    for (const status of [...RESTRICTED_STATUSES, 'unknown']) {
      const content = restrictedContent(status);
      for (const key of [content.titleKey, content.explanationKey, content.nextStepKey]) {
        expect(lookup(key).trim().length).toBeGreaterThan(0);
      }
      for (const action of content.actions) {
        expect(lookup(`restricted.action.${action}`).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('has the error strings the API can trigger', () => {
    expect(lookup('errors.accountRestricted')).toBeTruthy();
    expect(lookup('errors.staffProtected')).toBeTruthy();
  });
});
