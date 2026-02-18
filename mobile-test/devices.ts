import { devices as playwrightDevices } from 'playwright';

export type DeviceCategory = 'small-phone' | 'standard-phone' | 'large-phone' | 'small-tablet' | 'standard-tablet' | 'large-tablet';

export interface DeviceEntry {
  name: string;
  category: DeviceCategory;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent: string;
  expectedBreakpoint: 'phone' | 'tablet' | 'desktop';
  isIOS: boolean;
  defaultBrowserType: 'chromium' | 'webkit';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function breakpointFor(width: number): 'phone' | 'tablet' | 'desktop' {
  if (width < 430) return 'phone';
  if (width < 768) return 'tablet';
  return 'desktop';
}

function categoryFor(width: number): DeviceCategory {
  if (width < 375) return 'small-phone';
  if (width < 430) return 'standard-phone';
  if (width < 600) return 'large-phone';
  if (width < 768) return 'small-tablet';
  if (width < 834) return 'standard-tablet';
  return 'large-tablet';
}

/** Map a Playwright device (portrait only) to a DeviceEntry. */
function fromPlaywright(name: string): DeviceEntry | null {
  const pw = playwrightDevices[name];
  if (!pw || !pw.isMobile) return null;
  const ua = pw.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  return {
    name,
    category: categoryFor(pw.viewport.width),
    viewport: { ...pw.viewport },
    deviceScaleFactor: pw.deviceScaleFactor,
    isMobile: true,
    hasTouch: pw.hasTouch,
    userAgent: ua,
    expectedBreakpoint: breakpointFor(pw.viewport.width),
    isIOS,
    defaultBrowserType: pw.defaultBrowserType as 'chromium' | 'webkit',
  };
}

/** Create a custom DeviceEntry for devices not in Playwright. */
function custom(
  name: string,
  width: number,
  height: number,
  dpr: number,
  ua: string,
  isIOS: boolean,
): DeviceEntry {
  return {
    name,
    category: categoryFor(width),
    viewport: { width, height },
    deviceScaleFactor: dpr,
    isMobile: true,
    hasTouch: true,
    userAgent: ua,
    expectedBreakpoint: breakpointFor(width),
    isIOS,
    defaultBrowserType: isIOS ? 'webkit' : 'chromium',
  };
}

// ---------------------------------------------------------------------------
// Playwright-sourced devices (portrait only, no landscape)
// ---------------------------------------------------------------------------

const PLAYWRIGHT_DEVICE_NAMES = [
  // Small phones (<375px)
  'iPhone SE',           // 320x568
  'Galaxy S9+',          // 320x658
  'Nokia Lumia 520',     // 320x533
  'Galaxy S III',        // 360x640
  'Galaxy Note 3',       // 360x640
  'Galaxy Note II',      // 360x640
  'Galaxy S5',           // 360x640
  'Galaxy S8',           // 360x740
  'Galaxy S24',          // 360x780
  'BlackBerry Z30',      // 360x640
  'Microsoft Lumia 550', // 360x640
  'Microsoft Lumia 950', // 360x640
  'Nexus 5',             // 360x640
  'Moto G4',             // 360x640
  'Pixel 4',             // 353x745

  // Standard phones (375-429px)
  'iPhone 6',            // 375x667
  'iPhone 7',            // 375x667
  'iPhone 8',            // 375x667
  'iPhone SE (3rd gen)', // 375x667
  'iPhone X',            // 375x812
  'iPhone 11 Pro',       // 375x635
  'iPhone 12 Mini',      // 375x629
  'iPhone 13 Mini',      // 375x629
  'LG Optimus L70',      // 384x640
  'Nexus 4',             // 384x640
  'iPhone 12',           // 390x664
  'iPhone 12 Pro',       // 390x664
  'iPhone 13',           // 390x664
  'iPhone 13 Pro',       // 390x664
  'iPhone 14',           // 390x664
  'iPhone 14 Pro',       // 393x660
  'iPhone 15',           // 393x659
  'iPhone 15 Pro',       // 393x659
  'Pixel 3',             // 393x786
  'Pixel 5',             // 393x727
  'Pixel 2',             // 411x731
  'Pixel 2 XL',          // 411x823
  'Pixel 7',             // 412x839
  'Pixel 4a (5G)',       // 412x765
  'Nexus 5X',            // 412x732
  'Nexus 6',             // 412x732
  'Nexus 6P',            // 412x732
  'iPhone 6 Plus',       // 414x736
  'iPhone 7 Plus',       // 414x736
  'iPhone 8 Plus',       // 414x736
  'iPhone XR',           // 414x896
  'iPhone 11',           // 414x715
  'iPhone 11 Pro Max',   // 414x715
  'iPhone 12 Pro Max',   // 428x746
  'iPhone 13 Pro Max',   // 428x746
  'iPhone 14 Plus',      // 428x746

  // Large phones (430-599px)
  'iPhone 14 Pro Max',   // 430x740
  'iPhone 15 Plus',      // 430x739
  'iPhone 15 Pro Max',   // 430x739
  'Galaxy A55',          // 480x1040
  'Nokia N9',            // 480x854

  // Small tablets (600-767px)
  'Blackberry PlayBook', // 600x1024
  'Nexus 7',             // 600x960
  'Galaxy Tab S9',       // 640x1024
  'iPad (gen 11)',       // 656x944
  'Galaxy Tab S4',       // 712x1138

  // Standard tablets (768-834px)
  'iPad (gen 5)',        // 768x1024
  'iPad (gen 6)',        // 768x1024
  'iPad Mini',           // 768x1024
  'Kindle Fire HDX',     // 800x1280
  'Nexus 10',            // 800x1280
  'iPad (gen 7)',        // 810x1080

  // Large tablets (834px+)
  'iPad Pro 11',         // 834x1194
];

const playwrightEntries: DeviceEntry[] = PLAYWRIGHT_DEVICE_NAMES
  .map(n => fromPlaywright(n))
  .filter((d): d is DeviceEntry => d !== null);

// ---------------------------------------------------------------------------
// Custom devices — newer models and those missing from Playwright
// ---------------------------------------------------------------------------

const IOS_MOBILE_UA = (osVer: string) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${osVer} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1`;

const IPAD_UA = (osVer: string) =>
  `Mozilla/5.0 (iPad; CPU OS ${osVer} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1`;

const ANDROID_MOBILE_UA = (androidVer: string, model: string) =>
  `Mozilla/5.0 (Linux; Android ${androidVer}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Mobile Safari/537.36`;

const ANDROID_TABLET_UA = (androidVer: string, model: string) =>
  `Mozilla/5.0 (Linux; Android ${androidVer}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Safari/537.36`;

const customEntries: DeviceEntry[] = [
  // ── Small phones (<375px) ──────────────────────────────────────────────
  custom('iPhone 5',            320, 568, 2,   IOS_MOBILE_UA('10_3_4'), true),
  custom('iPhone 5s',           320, 568, 2,   IOS_MOBILE_UA('12_5_7'), true),
  custom('iPhone 5c',           320, 568, 2,   IOS_MOBILE_UA('10_3_3'), true),
  custom('iPod Touch (7th gen)',320, 568, 2,   IOS_MOBILE_UA('15_8'),   true),
  custom('Galaxy Y',            240, 320, 1,   ANDROID_MOBILE_UA('2.3.6', 'GT-S5360'), false),
  custom('Galaxy Ace',          320, 480, 1,   ANDROID_MOBILE_UA('2.3.7', 'GT-S5830'), false),
  custom('Pixel 4a',            353, 745, 2.75, ANDROID_MOBILE_UA('12', 'Pixel 4a'),  false),

  // ── Standard phones (375-429px) ────────────────────────────────────────
  custom('iPhone 16',           393, 659, 3,   IOS_MOBILE_UA('18_0'), true),
  custom('iPhone 16 Pro',       402, 674, 3,   IOS_MOBILE_UA('18_0'), true),
  custom('Galaxy S20',          360, 800, 3,   ANDROID_MOBILE_UA('12', 'SM-G980F'), false),
  custom('Galaxy S20 FE',       360, 800, 3,   ANDROID_MOBILE_UA('13', 'SM-G780F'), false),
  custom('Galaxy S21',          360, 800, 3,   ANDROID_MOBILE_UA('13', 'SM-G991B'), false),
  custom('Galaxy S21 FE',       360, 800, 3,   ANDROID_MOBILE_UA('14', 'SM-G990B'), false),
  custom('Galaxy S22',          360, 780, 3,   ANDROID_MOBILE_UA('14', 'SM-S901B'), false),
  custom('Galaxy S23',          360, 780, 3,   ANDROID_MOBILE_UA('14', 'SM-S911B'), false),
  custom('Galaxy S24 FE',       360, 780, 3,   ANDROID_MOBILE_UA('14', 'SM-S721B'), false),
  custom('Galaxy A54',          360, 800, 3,   ANDROID_MOBILE_UA('14', 'SM-A546B'), false),
  custom('Galaxy A34',          360, 800, 2.625, ANDROID_MOBILE_UA('14', 'SM-A346B'), false),
  custom('Galaxy A14',          384, 854, 1.5, ANDROID_MOBILE_UA('13', 'SM-A145F'), false),
  custom('Galaxy Z Flip 5',     412, 919, 2.625, ANDROID_MOBILE_UA('14', 'SM-F731B'), false),
  custom('Galaxy Z Flip 4',     412, 919, 2.625, ANDROID_MOBILE_UA('14', 'SM-F721B'), false),
  custom('Pixel 6',             412, 915, 2.625, ANDROID_MOBILE_UA('14', 'Pixel 6'),  false),
  custom('Pixel 6a',            412, 892, 2.625, ANDROID_MOBILE_UA('14', 'Pixel 6a'), false),
  custom('Pixel 7a',            412, 892, 2.625, ANDROID_MOBILE_UA('14', 'Pixel 7a'), false),
  custom('Pixel 8',             412, 915, 2.625, ANDROID_MOBILE_UA('14', 'Pixel 8'),  false),
  custom('Pixel 8a',            412, 892, 2.625, ANDROID_MOBILE_UA('14', 'Pixel 8a'), false),
  custom('Pixel 9',             412, 923, 2.75, ANDROID_MOBILE_UA('15', 'Pixel 9'),   false),
  custom('OnePlus 12',          412, 915, 2.625, ANDROID_MOBILE_UA('14', 'CPH2581'),  false),
  custom('OnePlus Nord 3',      412, 915, 2.625, ANDROID_MOBILE_UA('14', 'CPH2491'),  false),
  custom('Xiaomi 14',           393, 873, 2.75, ANDROID_MOBILE_UA('14', '23127PN0CC'), false),
  custom('Xiaomi Redmi Note 13',393, 873, 2.75, ANDROID_MOBILE_UA('14', '23106RN0DA'), false),
  custom('Nothing Phone (2)',   412, 915, 2.625, ANDROID_MOBILE_UA('14', 'A065'), false),
  custom('Sony Xperia 1 V',    411, 960, 2.625, ANDROID_MOBILE_UA('14', 'XQ-DQ72'), false),

  // ── Large phones (430-599px) ───────────────────────────────────────────
  custom('iPhone 16 Plus',      430, 739, 3,   IOS_MOBILE_UA('18_0'), true),
  custom('iPhone 16 Pro Max',   440, 756, 3,   IOS_MOBILE_UA('18_0'), true),
  custom('Galaxy S20 Ultra',    432, 960, 3,   ANDROID_MOBILE_UA('13', 'SM-G988B'), false),
  custom('Galaxy S21 Ultra',    432, 960, 3,   ANDROID_MOBILE_UA('13', 'SM-G998B'), false),
  custom('Galaxy S22 Ultra',    432, 960, 3,   ANDROID_MOBILE_UA('14', 'SM-S908B'), false),
  custom('Galaxy S23 Ultra',    432, 960, 3,   ANDROID_MOBILE_UA('14', 'SM-S918B'), false),
  custom('Galaxy S24 Ultra',    432, 960, 3,   ANDROID_MOBILE_UA('14', 'SM-S928B'), false),
  custom('Galaxy Z Fold 5',     460, 1016, 2.5, ANDROID_MOBILE_UA('14', 'SM-F946B'), false),
  custom('Pixel 6 Pro',         440, 990, 2.625, ANDROID_MOBILE_UA('14', 'Pixel 6 Pro'), false),
  custom('Pixel 7 Pro',         440, 990, 2.625, ANDROID_MOBILE_UA('14', 'Pixel 7 Pro'), false),
  custom('Pixel 8 Pro',         448, 998, 2.625, ANDROID_MOBILE_UA('14', 'Pixel 8 Pro'), false),
  custom('Pixel 9 Pro XL',      448, 998, 2.75, ANDROID_MOBILE_UA('15', 'Pixel 9 Pro XL'), false),
  custom('OnePlus 12 Pro',      440, 990, 2.625, ANDROID_MOBILE_UA('14', 'CPH2583'), false),

  // ── Small tablets (600-767px) ──────────────────────────────────────────
  custom('Galaxy Tab A8',        600, 1024, 1.5, ANDROID_TABLET_UA('14', 'SM-X200'),  false),
  custom('Galaxy Tab S6 Lite',   600, 1024, 1.5, ANDROID_TABLET_UA('14', 'SM-P613'),  false),
  custom('Galaxy Tab A7 Lite',   600, 960,  1.5, ANDROID_TABLET_UA('13', 'SM-T220'),  false),
  custom('Kindle Fire HD 8',     600, 1024, 1.5, 'Mozilla/5.0 (Linux; Android 11; KFRAPWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/110.1.4 like Chrome/110.0.5481.154 Safari/537.36', false),
  custom('Lenovo Tab M10',       600, 1024, 1.5, ANDROID_TABLET_UA('12', 'TB-X606F'),  false),
  custom('Xiaomi Pad 6',         600, 960,  2,   ANDROID_TABLET_UA('14', '23043RP34G'), false),

  // ── Standard tablets (768-834px) ───────────────────────────────────────
  custom('iPad Air (5th gen)',   820, 1180, 2,   IPAD_UA('16_0'), true),
  custom('iPad (9th gen)',       810, 1080, 2,   IPAD_UA('16_0'), true),
  custom('iPad (10th gen)',      820, 1180, 2,   IPAD_UA('16_0'), true),
  custom('iPad Mini (6th gen)',  768, 1024, 2,   IPAD_UA('16_0'), true),
  custom('Galaxy Tab S7',        800, 1280, 2,   ANDROID_TABLET_UA('13', 'SM-T870'),  false),
  custom('Galaxy Tab S8',        800, 1280, 2,   ANDROID_TABLET_UA('14', 'SM-X700'),  false),

  // ── Large tablets (834px+) ──────────────────────────────────────────────
  custom('iPad Pro 12.9 (6th gen)', 1024, 1366, 2, IPAD_UA('16_0'), true),
  custom('iPad Pro 11 (4th gen)',   834, 1194, 2,  IPAD_UA('16_0'), true),
  custom('iPad Air (M2)',           834, 1194, 2,  IPAD_UA('17_0'), true),
  custom('Surface Pro 7',          912, 1368, 2,
    'Mozilla/5.0 (Windows NT 10.0; ARM; Surface Pro 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Safari/537.36 Edg/145.0.0.0', false),
  custom('Galaxy Tab S8+',         840, 1344, 2.25, ANDROID_TABLET_UA('14', 'SM-X800'), false),
  custom('Galaxy Tab S9+',         840, 1344, 2.25, ANDROID_TABLET_UA('14', 'SM-X810'), false),
  custom('Galaxy Tab S9 Ultra',    900, 1440, 2.25, ANDROID_TABLET_UA('14', 'SM-X910'), false),
  custom('Pixel Tablet',           888, 1280, 2,   ANDROID_TABLET_UA('14', 'GPD8'),     false),
  custom('Lenovo Tab P12 Pro',     900, 1440, 2,   ANDROID_TABLET_UA('13', 'TB-Q706F'), false),
];

// ---------------------------------------------------------------------------
// Merged registry
// ---------------------------------------------------------------------------

/** All devices — Playwright-sourced + custom entries. */
export const DEVICE_REGISTRY: DeviceEntry[] = [...playwrightEntries, ...customEntries];

// ---------------------------------------------------------------------------
// Per-category exports
// ---------------------------------------------------------------------------

export const SMALL_PHONES:      DeviceEntry[] = DEVICE_REGISTRY.filter(d => d.category === 'small-phone');
export const STANDARD_PHONES:   DeviceEntry[] = DEVICE_REGISTRY.filter(d => d.category === 'standard-phone');
export const LARGE_PHONES:      DeviceEntry[] = DEVICE_REGISTRY.filter(d => d.category === 'large-phone');
export const SMALL_TABLETS:     DeviceEntry[] = DEVICE_REGISTRY.filter(d => d.category === 'small-tablet');
export const STANDARD_TABLETS:  DeviceEntry[] = DEVICE_REGISTRY.filter(d => d.category === 'standard-tablet');
export const LARGE_TABLETS:     DeviceEntry[] = DEVICE_REGISTRY.filter(d => d.category === 'large-tablet');

// ---------------------------------------------------------------------------
// Platform exports
// ---------------------------------------------------------------------------

export const IOS_DEVICES:     DeviceEntry[] = DEVICE_REGISTRY.filter(d => d.isIOS);
export const ANDROID_DEVICES: DeviceEntry[] = DEVICE_REGISTRY.filter(d => !d.isIOS);

// ---------------------------------------------------------------------------
// Representative devices — one per category for quick smoke tests
// ---------------------------------------------------------------------------

export const REPRESENTATIVE_DEVICES: Record<DeviceCategory, DeviceEntry> = {
  'small-phone':     SMALL_PHONES.find(d => d.name === 'iPhone SE')!,
  'standard-phone':  STANDARD_PHONES.find(d => d.name === 'iPhone 14 Pro')!,
  'large-phone':     LARGE_PHONES.find(d => d.name === 'iPhone 15 Pro Max')!,
  'small-tablet':    SMALL_TABLETS.find(d => d.name === 'Nexus 7')!,
  'standard-tablet': STANDARD_TABLETS.find(d => d.name === 'iPad Mini')!,
  'large-tablet':    LARGE_TABLETS.find(d => d.name === 'iPad Pro 11')!,
};
