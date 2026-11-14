import { describe, expect, it } from 'vitest';
import { foldDevices, realIdOf } from './devices';

const dev = (
  deviceId: string,
  groupId: string,
  label = deviceId,
  kind: MediaDeviceKind = 'audioinput',
) => ({ deviceId, groupId, label, kind }) as MediaDeviceInfo;

describe('foldDevices', () => {
  it('folds default / communications into the real devices and marks the default', () => {
    const list = [
      dev('default', 'g2', '既定 - USB Mic'),
      dev('communications', 'g1', '通信 - Built-in'),
      dev('real-1', 'g1', 'Built-in'),
      dev('real-2', 'g2', 'USB Mic'),
      dev('out-1', 'g2', 'Speaker', 'audiooutput'),
    ];
    expect(foldDevices(list)).toEqual([
      { deviceId: 'real-1', label: 'Built-in', isDefault: false },
      { deviceId: 'real-2', label: 'USB Mic', isDefault: true },
    ]);
  });

  it('without a shared groupId, the twin is found by the label after " - "', () => {
    expect(
      foldDevices([
        dev('default', 'gx', 'Default - USB Mic'),
        dev('real-1', 'g1', 'Built-in'),
        dev('real-2', 'g2', 'USB Mic'),
      ]),
    ).toEqual([
      { deviceId: 'real-1', label: 'Built-in', isDefault: false },
      { deviceId: 'real-2', label: 'USB Mic', isDefault: true },
    ]);
  });

  it('a groupId shared by two real inputs falls back to the label', () => {
    expect(
      foldDevices([
        dev('default', 'g1', '既定 - In 2'),
        dev('in-1', 'g1', 'In 1'),
        dev('in-2', 'g1', 'In 2'),
      ]).find((d) => d.isDefault)?.deviceId,
    ).toBe('in-2');
  });

  it('keeps a default without a real twin (Chromium fake device); drops a lonely communications', () => {
    expect(
      foldDevices([
        dev('default', 'gx', 'Default'),
        dev('communications', 'gy'),
      ]),
    ).toEqual([{ deviceId: 'default', label: 'Default', isDefault: true }]);
  });

  it('before the permission (one entry, empty ids) the first input is the default', () => {
    expect(foldDevices([dev('', '', '')])).toEqual([
      { deviceId: '', label: '', isDefault: true },
    ]);
  });

  it('no inputs → []', () => {
    expect(foldDevices([])).toEqual([]);
  });
});

describe('realIdOf', () => {
  const list = [
    dev('default', 'g2', '既定 - USB Mic'),
    dev('real-1', 'g1', 'Built-in'),
    dev('real-2', 'g2', 'USB Mic'),
  ];

  it('a real id stays', () => {
    expect(realIdOf('real-1', undefined, list)).toBe('real-1');
  });

  it("a virtual id becomes its twin (by the track's groupId, else the entry's)", () => {
    expect(realIdOf('default', 'g1', list)).toBe('real-1');
    expect(realIdOf('default', undefined, list)).toBe('real-2');
  });

  it('a virtual id with no twin stays', () => {
    expect(
      realIdOf('default', undefined, [dev('default', 'gx', 'Default')]),
    ).toBe('default');
  });
});
