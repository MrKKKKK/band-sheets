import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SectionPartBar, type SectionPartBarProps } from './SectionPartBar';

const SECTION_OPTIONS = [
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
];

/** Holds section/part/name state like an editor would. */
function Demo({
  onSectionLabelChange,
  onPartOrdinalChange,
  onRenamePart,
  ...props
}: SectionPartBarProps & { initialPartName?: string }) {
  const [sectionLabel, setSectionLabel] = useState(props.sectionLabel);
  const [partOrdinal, setPartOrdinal] = useState(props.partOrdinal);
  const [partName, setPartName] = useState(props.partName);
  return (
    <SectionPartBar
      {...props}
      sectionLabel={sectionLabel}
      onSectionLabelChange={(l) => {
        onSectionLabelChange(l);
        setSectionLabel(l);
      }}
      partOrdinal={partOrdinal}
      onPartOrdinalChange={(o) => {
        onPartOrdinalChange(o);
        setPartOrdinal(o);
      }}
      partName={partName}
      onRenamePart={(name) => {
        const error = onRenamePart(name);
        if (error === undefined) setPartName(name);
        return error;
      }}
    />
  );
}

const meta = {
  title: 'Melody/SectionPartBar',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: {
    sectionOptions: SECTION_OPTIONS,
    sectionLabel: 'A',
    onSectionLabelChange: fn(),
    partNames: ['Vocal'],
    partOrdinal: 0,
    onPartOrdinalChange: fn(),
    partName: 'Vocal',
    noPartHint: 'パート「Vocal」は最初の入力で作られます',
    onRenamePart: fn((name: string) =>
      name.trim() === '' ? 'パート名を入力してください' : undefined,
    ),
  },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Section buttons switch the section. */
export const SectionSwitch: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const a = canvas.getByRole('button', { name: 'A' });
    const b = canvas.getByRole('button', { name: 'B' });
    expect(a).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(b);
    expect(args.onSectionLabelChange).toHaveBeenCalledWith('B');
    expect(b).toHaveAttribute('aria-pressed', 'true');
  },
};

/** Only one part: no part <select>, just the rename row. */
export const SinglePartRename: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByLabelText('パート')).not.toBeInTheDocument();
    const input = canvas.getByLabelText('パート名');
    const save = canvas.getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();

    // Empty name: validation error, no commit.
    await userEvent.clear(input);
    await userEvent.click(save);
    expect(canvas.getByRole('alert')).toHaveTextContent(
      'パート名を入力してください',
    );

    // Valid name: commits, input keeps the new value.
    await userEvent.type(input, 'Lead');
    await userEvent.click(save);
    expect(args.onRenamePart).toHaveBeenCalledWith('Lead');
    expect(canvas.getByLabelText('パート名')).toHaveValue('Lead');
    expect(canvas.queryByRole('alert')).toBeNull();
    expect(canvas.getByRole('button', { name: '保存' })).toBeDisabled();
  },
};

/** Enter in the name field also saves. */
export const RenameWithEnter: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText('パート名');
    await userEvent.clear(input);
    await userEvent.type(input, 'Lead{Enter}');
    expect(args.onRenamePart).toHaveBeenCalledWith('Lead');
    expect(canvas.getByLabelText('パート名')).toHaveValue('Lead');
  },
};

/** Multiple parts: the <select> appears and switches the part. */
export const MultiplePartsSelect: Story = {
  args: { partNames: ['Vocal', 'Harmony'] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const select = canvas.getByLabelText('パート');
    await userEvent.selectOptions(select, 'Harmony');
    expect(args.onPartOrdinalChange).toHaveBeenCalledWith(1);
  },
};

/** No part yet: the hint text, no rename row. */
export const NoPartYet: Story = {
  args: { partName: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText('パート「Vocal」は最初の入力で作られます'),
    ).toBeInTheDocument();
    expect(canvas.queryByLabelText('パート名')).not.toBeInTheDocument();
  },
};
