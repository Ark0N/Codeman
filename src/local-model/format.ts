/**
 * @fileoverview The formatters of the local model recommendation, and its byte units.
 *
 * `formatGb()` is the ONE place a byte count becomes a size a person reads: decimal GB (the
 * unit the Finder and the model registry use). `hardware.ts` and `recommend.ts` call it to fill
 * the `...Gb` text fields of the payload (`memGb`, `freeDiskGb`, `needGb`, `downloadGb`,
 * `budgetGb`, and the size slots of a `LocalModelMessage`). Nothing else may turn bytes into a
 * size for display, the browser included: it prints the text it was sent.
 *
 * GiB and MiB exist only for the budget math (reserves, the wired limit, the device total the
 * runtime reports) and never reach a person, with one exception: `memClassGb()`, the memory
 * size a Mac is sold as, is how the card names the installed memory ("48 GB memory", what
 * About This Mac shows). It is a name of the machine, not a computed size: `formatGb()` of the
 * same bytes reads 51.5, which no owner recognises. Every computed size (need, budget,
 * download, free disk) is `formatGb()`.
 *
 * Pure: no IO, no state.
 */

/** One decimal gigabyte, the unit a person reads. */
export const GB = 1_000_000_000;
/** One binary gigabyte. Budget math only. */
export const GIB = 1024 ** 3;
/** One binary megabyte. Budget math only. */
export const MIB = 1024 ** 2;

/**
 * A byte count as decimal GB text, WITHOUT the unit: one decimal below 100 ('6.6', '17.7',
 * '25.5'), a whole number from 100 ('212'). The caller's sentence supplies ' GB'.
 * Anything that is not a positive finite number reads '0.0'.
 */
export function formatGb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.0';
  const tenths = Math.round((bytes / GB) * 10) / 10;
  return tenths >= 100 ? String(Math.round(bytes / GB)) : tenths.toFixed(1);
}

/**
 * The memory size a Mac is sold as: whole binary gigabytes (17179869184 bytes is 16). This is
 * `HardwareFacts.memClassGb`: the key of the tier rules ("below 36 GB") and of `TestedOn.memGb`,
 * and what the card and the `noneMemory` sentence call the installed memory. It names a class
 * of Mac; 0 means the size is unknown and is never shown. Any other size for display is
 * `formatGb()`.
 */
export function memClassGb(memBytes: number): number {
  if (!Number.isFinite(memBytes) || memBytes <= 0) return 0;
  return Math.round(memBytes / GIB);
}
