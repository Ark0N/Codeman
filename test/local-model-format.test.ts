/**
 * @fileoverview Tests for src/local-model/format.ts: the ONE place a byte count becomes a size a
 * person reads, and the memory class a Mac is sold as.
 *
 * What is pinned here is a contract with the browser: it prints the text it was sent and adds
 * ' GB' itself, so the text must be decimal GB, carry no unit, and round the same way everywhere.
 *
 * Port: N/A (pure functions).
 */

import { describe, expect, it } from 'vitest';
import { formatGb, GB, GIB, memClassGb, MIB } from '../src/local-model/format.js';

describe('byte units', () => {
  it('keeps decimal GB (what a person reads) apart from the binary units of the budget math', () => {
    expect(GB).toBe(1_000_000_000);
    expect(GIB).toBe(1_073_741_824);
    expect(MIB).toBe(1_048_576);
  });
});

describe('formatGb', () => {
  it('prints decimal GB, so a Mac sold as 16 GB reads 17.2 and one sold as 48 GB reads 51.5', () => {
    expect(formatGb(17_179_869_184)).toBe('17.2');
    expect(formatGb(51_539_607_552)).toBe('51.5');
  });

  it('prints the registry sizes of the catalogue models as the registry shows them', () => {
    expect(formatGb(6_550_825_373)).toBe('6.6');
    expect(formatGb(13_793_441_427)).toBe('13.8');
    expect(formatGb(17_741_871_939)).toBe('17.7');
    expect(formatGb(22_621_314_161)).toBe('22.6');
    expect(formatGb(81_370_035_877)).toBe('81.4');
  });

  it('keeps one decimal below 100 and none from 100', () => {
    expect(formatGb(1 * GB)).toBe('1.0');
    expect(formatGb(99.94 * GB)).toBe('99.9');
    // Rounds to 100.0, which is already "from 100".
    expect(formatGb(99.96 * GB)).toBe('100');
    expect(formatGb(100 * GB)).toBe('100');
    // The free disk of the two test Macs, from their `df -k` lines.
    expect(formatGb(890_926_084 * 1024)).toBe('912');
    expect(formatGb(41_752_848 * 1024)).toBe('42.8');
  });

  it('never prints a unit, a thousands separator or an exponent', () => {
    for (const bytes of [1, 5 * MIB, 3 * GIB, 250 * GB, 4000 * GB, 2.5e15]) {
      expect(formatGb(bytes)).toMatch(/^\d+(\.\d)?$/);
    }
  });

  it("reads '0.0' for anything that is not a positive size", () => {
    for (const bytes of [0, -1, -5 * GB, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatGb(bytes)).toBe('0.0');
    }
  });

  it('shows a size too small for one decimal as 0.0, never as an empty text', () => {
    expect(formatGb(10 * MIB)).toBe('0.0');
    expect(formatGb(512 * MIB)).toBe('0.5');
  });
});

describe('memClassGb', () => {
  it('names the size a Mac is sold as: whole binary gigabytes', () => {
    for (const sold of [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192]) {
      expect(memClassGb(sold * GIB)).toBe(sold);
    }
    // The exact `hw.memsize` of the two test Macs.
    expect(memClassGb(17_179_869_184)).toBe(16);
    expect(memClassGb(51_539_607_552)).toBe(48);
  });

  it('rounds a size that is not a whole number of gigabytes', () => {
    // `hw.memsize_usable` of the 16 GB test Mac is a little below 16 GiB.
    expect(memClassGb(16_631_808_000)).toBe(15);
    expect(memClassGb(16 * GIB - 100 * MIB)).toBe(16);
  });

  it('reads 0 for anything that is not a positive size', () => {
    for (const bytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(memClassGb(bytes)).toBe(0);
    }
  });
});
