/**
 * Locks in the `@` mention popover keyboard contract for the empty-result
 * edge case (issue #13929 / PR #13928): when filtering yields zero matches
 * the arrow keys must be no-ops rather than computing a `% 0` -> NaN active
 * index, and Enter/Tab must close the popover and return focus to the
 * textarea. Deleting back to a non-empty list has to leave keyboard
 * navigation working from a valid index.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { RecoilState } from 'recoil';
import type { MentionOption } from '~/common';

const POPOVER_ATOM = 'show-mention-popover';
const PLACEHOLDER = 'com_ui_mention';

const mockSetShowPopover = jest.fn();
const mockShowPopover = { current: true };
const mockLocalize = (key: string) => key;

jest.mock('recoil', () => {
  const actual = jest.requireActual('recoil');
  return {
    ...actual,
    useRecoilValue: jest.fn((atom: unknown) =>
      atom === POPOVER_ATOM ? mockShowPopover.current : undefined,
    ),
    useSetRecoilState: jest.fn((atom: unknown) =>
      atom === POPOVER_ATOM ? mockSetShowPopover : jest.fn(),
    ),
  };
});

const mockUseMentions = jest.fn();
jest.mock('~/hooks/Input/useMentions', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseMentions(...args),
}));

jest.mock('~/hooks/Input/useSelectMention', () => ({
  __esModule: true,
  default: () => ({ onSelectMention: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
  useGetConversation: () => jest.fn(),
}));

jest.mock('~/Providers', () => ({
  useAssistantsMapContext: () => ({}),
}));

/* react-virtualized renders nothing in jsdom without a measured size; replace
   AutoSizer + List with a flat ul so every row's MentionItem button renders. */
jest.mock('react-virtualized', () => ({
  ...jest.requireActual('react-virtualized'),
  AutoSizer: ({ children }: { children: (size: { width: number }) => React.ReactNode }) =>
    children({ width: 320 }),
  List: ({
    rowCount,
    rowRenderer,
  }: {
    rowCount: number;
    rowRenderer: (args: {
      index: number;
      key: string;
      style: React.CSSProperties;
    }) => React.ReactNode;
  }) => {
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < rowCount; i++) {
      rows.push(rowRenderer({ index: i, key: `row-${i}`, style: {} }));
    }
    return <ul data-testid="mention-list">{rows}</ul>;
  },
}));

import Mention from '../Mention';

const makeTextarea = (initial = '@') => {
  const textarea = document.createElement('textarea');
  textarea.value = initial;
  document.body.appendChild(textarea);
  return { current: textarea } as React.MutableRefObject<HTMLTextAreaElement | null>;
};

const makeMention = (overrides: Partial<MentionOption>): MentionOption => ({
  type: 'preset',
  label: 'Alpha',
  value: 'alpha',
  description: '',
  ...overrides,
});

const options: MentionOption[] = [
  makeMention({ label: 'Alpha', value: 'alpha' }),
  makeMention({ label: 'Beta', value: 'beta' }),
];

const mentionsBundle = {
  options,
  presets: [],
  isLoading: false,
  modelSpecs: [],
  agentsList: [],
  modelsConfig: {},
  endpointsConfig: {},
  assistantListMap: {},
};

const activeItemId = () =>
  document.querySelector('.bg-surface-active')?.closest('button')?.id ?? null;

const getInput = () => screen.getByPlaceholderText(PLACEHOLDER);

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
  mockShowPopover.current = true;
  mockUseMentions.mockReturnValue(mentionsBundle);
});

const renderMention = () => {
  const textAreaRef = makeTextarea('@');
  const utils = render(
    <Mention
      index={0}
      popoverAtom={POPOVER_ATOM as unknown as RecoilState<boolean>}
      newConversation={jest.fn()}
      textAreaRef={textAreaRef}
    />,
  );
  return { textAreaRef, ...utils };
};

describe('Mention keyboard navigation', () => {
  it('renders nothing when the popover atom is false', () => {
    mockShowPopover.current = false;
    const { container } = renderMention();
    expect(container).toBeEmptyDOMElement();
  });

  it('moves the active highlight with ArrowDown/ArrowUp and wraps around', () => {
    renderMention();
    const input = getInput();

    expect(activeItemId()).toBe('mention-item-0');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('mention-item-1');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('mention-item-0');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeItemId()).toBe('mention-item-1');
  });

  it('keeps navigation working after filtering to zero matches and back', () => {
    renderMention();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.queryByRole('button')).toBeNull();

    /* Arrow keys on an empty list must be no-ops, not `% 0` -> NaN. */
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getAllByRole('button')).toHaveLength(2);

    /* Without the guard the active index would still be NaN here and no
       item would highlight; with it, navigation resumes from a valid index. */
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('mention-item-1');
  });

  it('closes the popover and refocuses the textarea when Enter is pressed with no matches', () => {
    const { textAreaRef } = renderMention();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter' });

    expect(notPrevented).toBe(false);
    expect(mockSetShowPopover).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(textAreaRef.current);
  });

  it('prevents the default Tab action when closing on no matches so the refocus sticks', () => {
    const { textAreaRef } = renderMention();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    const notPrevented = fireEvent.keyDown(input, { key: 'Tab' });

    /* Without preventDefault the browser's default Tab would move focus off
       the textarea right after we refocus it. */
    expect(notPrevented).toBe(false);
    expect(mockSetShowPopover).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(textAreaRef.current);
  });
});

describe('person mention discovery', () => {
  it('shows a people-search shortcut at @p and keeps normal @ suggestions available', () => {
    const textAreaRef = makeTextarea('@p');
    render(
      <Mention
        index={0}
        popoverAtom={POPOVER_ATOM as unknown as RecoilState<boolean>}
        newConversation={jest.fn()}
        textAreaRef={textAreaRef}
      />,
    );

    expect(screen.getByRole('button', { name: 'com_ui_search_people' })).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(textAreaRef.current?.value).toBe('');
  });

  it('navigates to the people-search option and opens directory search with Enter', () => {
    const textAreaRef = makeTextarea('@p');
    render(
      <Mention
        index={0}
        popoverAtom={POPOVER_ATOM as unknown as RecoilState<boolean>}
        newConversation={jest.fn()}
        textAreaRef={textAreaRef}
      />,
    );

    const input = getInput();
    expect(activeItemId()).toBe('mention-item-0');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('mention-item-1');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeItemId()).toBe('mention-item-0');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByPlaceholderText('com_ui_search_people')).toBeInTheDocument();
    expect(mockUseMentions).toHaveBeenLastCalledWith(
      expect.objectContaining({ searchPeople: true, searchValue: '' }),
    );
  });

  it('navigates and selects directory results with ArrowUp, ArrowDown, and Enter', () => {
    const people: MentionOption[] = [
      makeMention({ type: 'person', label: 'Alex Security', value: 'alex-id' }),
      makeMention({ type: 'person', label: 'Alex DevOps', value: 'devops-id' }),
    ];
    const textAreaRef = makeTextarea('@p');
    render(
      <Mention
        index={0}
        popoverAtom={POPOVER_ATOM as unknown as RecoilState<boolean>}
        newConversation={jest.fn()}
        textAreaRef={textAreaRef}
      />,
    );

    const mentionInput = getInput();
    fireEvent.keyDown(mentionInput, { key: 'Enter' });
    const peopleInput = screen.getByPlaceholderText('com_ui_search_people');

    mockUseMentions.mockReturnValue({
      ...mentionsBundle,
      options: people,
    });
    fireEvent.change(peopleInput, { target: { value: 'alex' } });

    expect(activeItemId()).toBe('mention-item-0');
    fireEvent.keyDown(peopleInput, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('mention-item-1');
    expect(document.getElementById('mention-item-1')).toHaveTextContent('Alex Security');
    fireEvent.keyDown(peopleInput, { key: 'ArrowUp' });
    expect(activeItemId()).toBe('mention-item-0');
    fireEvent.keyDown(peopleInput, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('mention-item-1');
    fireEvent.keyDown(peopleInput, { key: 'Enter' });

    expect(textAreaRef.current?.value).toBe('@person Alex Security ');
  });

  it('enters the people directory when the user types the full @person prefix and a space', () => {
    const textAreaRef = makeTextarea('@p');
    render(
      <Mention
        index={0}
        popoverAtom={POPOVER_ATOM as unknown as RecoilState<boolean>}
        newConversation={jest.fn()}
        textAreaRef={textAreaRef}
      />,
    );

    fireEvent.change(getInput(), { target: { value: 'person ' } });

    expect(screen.getByPlaceholderText('com_ui_search_people')).toBeInTheDocument();
  });
});
