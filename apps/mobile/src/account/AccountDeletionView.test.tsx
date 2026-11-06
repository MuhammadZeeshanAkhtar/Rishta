import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DELETION_GRACE_DAYS, type DeletionRequest } from '@nikahmate/domain';
import catalog from '../../../../packages/i18n/src/locales/en.json';
import { AccountDeletionView, type AccountDeletionViewProps } from './AccountDeletionView';
import { DELETION_CONFIRMATION_WORD, deletionConfirmed, deletionDetails } from './accountDeletion';

/**
 * The account deletion screen: the real view and the real English catalog, rendered
 * to markup, with its buttons pressed. React Native primitives are replaced by plain
 * elements because this suite has no native renderer.
 */

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children: ReactNode }) => createElement('p', null, children),
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../components/Screen', () => ({
  Screen: ({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle: string;
    children: ReactNode;
  }) =>
    createElement(
      'main',
      null,
      createElement('h1', null, title),
      createElement('h2', null, subtitle),
      children,
    ),
}));
vi.mock('../components/Banner', () => ({
  Banner: ({ message }: { message: string }) => createElement('aside', null, message),
}));
vi.mock('../components/TextField', () => ({
  TextField: (props: { label: string; value: string; editable?: boolean }) =>
    createElement(
      'label',
      null,
      props.label,
      createElement('input', {
        defaultValue: props.value,
        disabled: props.editable === false,
      }),
    ),
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

const props = (extra: Partial<AccountDeletionViewProps> = {}): AccountDeletionViewProps => ({
  t: lookup,
  colors: { text: '#000', textMuted: '#555' },
  typed: '',
  onChangeTyped: () => {},
  busy: false,
  error: null,
  onConfirm: () => {},
  onCancel: () => {},
  ...extra,
});

const render = (extra: Partial<AccountDeletionViewProps> = {}) =>
  renderToStaticMarkup(createElement(AccountDeletionView, props(extra))).replace(/&#x27;/g, "'");

function find(element: ReactNode, testID: string): { onPress?: () => void; disabled?: boolean } {
  let found: { onPress?: () => void; disabled?: boolean } | undefined;
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const el = node as ReactElement<{
      testID?: string;
      onPress?: () => void;
      disabled?: boolean;
      children?: ReactNode;
    }>;
    if (el.props.testID === testID) found = el.props;
    walk(el.props.children);
  };
  walk(element);
  if (!found) throw new Error(`No element ${testID}`);
  return found;
}

describe('what it says before anything happens', () => {
  it('says the profile is hidden at once', () => {
    expect(render()).toContain('hidden from other members straight away');
  });

  it('gives the real grace period, the one the API uses', () => {
    expect(DELETION_GRACE_DAYS).toBe(30);
    expect(render()).toContain('You have 30 days to change your mind');
    expect(render()).not.toContain('{{days}}');
  });

  it('says how to undo it', () => {
    expect(render()).toContain('Keep my account');
  });

  it('says what is removed, and what is kept', () => {
    const html = render();
    expect(html).toContain('name, date of birth, private details and photos are removed');
    expect(html).toContain("stay in the other person's conversation");
    expect(html).toContain('Some safety and legal records are kept');
  });

  it('says a safety review can delay it', () => {
    expect(render()).toContain('a safety review is open');
  });

  it('names the word to type', () => {
    expect(render()).toContain(`Type ${DELETION_CONFIRMATION_WORD} to confirm`);
    expect(render()).not.toContain('{{word}}');
  });
});

describe('the confirmation', () => {
  it.each(['', 'delet', 'DELETE ME', 'yes', 'REMOVE'])('%j does not count', (typed) => {
    expect(deletionConfirmed(typed)).toBe(false);
    const view = RenderedView({ typed });
    expect(find(view, 'delete-account-confirm').disabled).toBe(true);
  });

  it.each(['DELETE', 'delete', ' Delete ', 'DELETE\n'])('%j does', (typed) => {
    expect(deletionConfirmed(typed)).toBe(true);
    const view = RenderedView({ typed });
    expect(find(view, 'delete-account-confirm').disabled).toBe(false);
  });

  function RenderedView(extra: Partial<AccountDeletionViewProps>) {
    return AccountDeletionView(props(extra));
  }

  it('pressing it asks for deletion, once', () => {
    const onConfirm = vi.fn();
    find(AccountDeletionView(props({ typed: 'DELETE', onConfirm })), 'delete-account-confirm')
      .onPress!();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('there is a way back that changes nothing', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    find(AccountDeletionView(props({ onCancel, onConfirm })), 'delete-account-cancel').onPress!();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('while it runs, and when it fails', () => {
  it('shows progress and cannot be pressed twice', () => {
    const html = render({ typed: 'DELETE', busy: true });
    expect(html).toMatch(/data-testid="delete-account-confirm"[^>]*data-loading="true"/);
    expect(html).toMatch(/data-testid="delete-account-cancel"[^>]*disabled/);
  });

  it('shows the failure, and the person can still leave', () => {
    const html = render({ typed: 'DELETE', error: 'No connection.' });
    expect(html).toContain('<aside>No connection.</aside>');
    expect(html).toContain('Keep my account');
  });
});

describe('deletionDetails', () => {
  const request = (status: DeletionRequest['status']): DeletionRequest => ({
    requestedAt: '2026-11-06T00:00:00.000Z',
    scheduledFor: '2026-12-06T00:00:00.000Z',
    status,
    heldReason: status === 'held' ? 'A safety review.' : null,
  });

  it('knows nothing without a request, and guesses nothing', () => {
    expect(deletionDetails(null)).toEqual({ scheduledOn: null, held: false });
  });

  it('gives the date from the request', () => {
    expect(deletionDetails(request('pending'), () => 'the date')).toEqual({
      scheduledOn: 'the date',
      held: false,
    });
  });

  it('reports a hold', () => {
    expect(deletionDetails(request('held'), () => 'the date').held).toBe(true);
  });
});

describe('it can be reached from everywhere it must be', () => {
  const ROOT = join(__dirname, '..', '..');
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

  it('the Me tab', () => {
    const source = read('app/(app)/(tabs)/me.tsx');
    expect(source).toContain("router.push('/delete-account'");
    expect(source).toContain('me-delete-account');
  });

  it('every onboarding step', () => {
    const source = read('src/onboarding/OnboardingStep.tsx');
    expect(source).toContain("router.push('/delete-account'");
  });

  it('the restricted screen', () => {
    expect(read('app/restricted.tsx')).toContain("router.push('/delete-account'");
  });

  it('someone with a request already open is sent to the pending state, not asked again', () => {
    const source = read('app/delete-account.tsx');
    expect(source).toContain("me?.status === 'pending_deletion'");
    expect(source).toContain("<Redirect href={'/restricted'");
  });
});
