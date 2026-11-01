/**
 * Folding Chromium's virtual `default` / `communications` input entries into their real devices (pure;
 * docs/mic-recording-plan.md §2.5). The browser calls stay in src/audio/micSession.ts.
 */
import type { MicDevice } from './micTypes';

export const VIRTUAL_IDS = new Set(['default', 'communications']);

type DeviceLike = Pick<MediaDeviceInfo, 'deviceId' | 'groupId' | 'label'>;

/**
 * The real input behind a virtual entry: the only real input with its `groupId`, else the only one whose label ends
 * the virtual label after " - " (Windows: 「既定 - USB Mic」 / "Default - USB Mic"). Chromium's fake device has a
 * `default` of its own (no twin).
 */
function twinOf(
  v: Pick<DeviceLike, 'groupId' | 'label'>,
  inputs: readonly DeviceLike[],
): DeviceLike | undefined {
  const real = inputs.filter((d) => !VIRTUAL_IDS.has(d.deviceId));
  const byGroup = v.groupId ? real.filter((d) => d.groupId === v.groupId) : [];
  if (byGroup.length === 1) return byGroup[0];
  const byLabel = real.filter(
    (d) => d.label && v.label.endsWith(` - ${d.label}`),
  );
  return byLabel.length === 1 ? byLabel[0] : undefined;
}

const audioInputs = (devices: readonly MediaDeviceInfo[]) =>
  devices.filter((d) => d.kind === 'audioinput');

/**
 * Folds Chromium's virtual `default` / `communications` entries into their real twins (`twinOf`); the twin of
 * `default` gets `isDefault`. A `default` with no twin is kept as it is (a device of its own); a lonely
 * `communications` is dropped.
 */
export function foldDevices(devices: readonly MediaDeviceInfo[]): MicDevice[] {
  const inputs = audioInputs(devices);
  const def = inputs.find((d) => d.deviceId === 'default');
  const defaultId = def ? (twinOf(def, inputs)?.deviceId ?? 'default') : null;
  const out: MicDevice[] = [];
  for (const d of inputs) {
    if (VIRTUAL_IDS.has(d.deviceId) && twinOf(d, inputs)) continue;
    if (d.deviceId === 'communications') continue;
    out.push({
      deviceId: d.deviceId,
      label: d.label,
      isDefault:
        defaultId !== null ? d.deviceId === defaultId : out.length === 0,
    });
  }
  return out;
}

/** The real device behind `id` (a virtual id → its twin); `id` itself when it is real or has no twin. */
export function realIdOf(
  id: string,
  groupId: string | undefined,
  devices: readonly MediaDeviceInfo[],
): string {
  if (!VIRTUAL_IDS.has(id)) return id;
  const inputs = audioInputs(devices);
  const v = inputs.find((d) => d.deviceId === id);
  return (
    twinOf(
      { groupId: groupId || v?.groupId || '', label: v?.label ?? '' },
      inputs,
    )?.deviceId ?? id
  );
}
