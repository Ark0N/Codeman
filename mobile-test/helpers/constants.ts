// Port assignments
export const PORTS = {
  KEYBOARD: 3200,
  TABS: 3201,
  SUBAGENT_WINDOWS: 3202,
  SETTINGS: 3203,
  LAYOUT: 3204,
  DEVICE_MATRIX: 3205,
  VISUAL_REGRESSION: 3206,
  ACCESSIBILITY: 3207,
} as const;

// CSS Selectors
export const SELECTORS = {
  // Header
  HEADER: '.header',
  HEADER_BRAND: '.header-brand',
  CASE_SELECT_GROUP: '.case-select-group',
  VERSION_DISPLAY: '.version-display',

  // Toolbar
  TOOLBAR: '.toolbar',
  TOOLBAR_RIGHT: '.toolbar-right',
  SETTINGS_MOBILE: '.btn-settings-mobile',
  CASE_MOBILE: '.btn-case-mobile',

  // Tabs
  TABS_CONTAINER: '.session-tabs',
  TAB: '.session-tab',
  TAB_ACTIVE: '.session-tab.active',
  TAB_CLOSE: '.tab-close',
  TAB_COUNT_GROUP: '.tab-count-group',
  TAB_NAME: '.tab-name',

  // Keyboard
  KEYBOARD_ACCESSORY: '.keyboard-accessory-bar',
  KEYBOARD_ACCESSORY_VISIBLE: '.keyboard-accessory-bar.visible',

  // Terminal
  TERMINAL_CONTAINER: '.terminal-container',
  MAIN: '.main',

  // Subagent windows
  SUBAGENT_WINDOW: '.subagent-window',
  SUBAGENT_HEADER: '.subagent-header',
  SUBAGENT_BADGE: '.subagent-badge',

  // Settings
  SETTINGS_MODAL: '#appSettingsModal',
  SETTINGS_MODAL_CONTENT: '.modal-content',
  SETTINGS_MODAL_BODY: '.modal-body',
  SETTINGS_MODAL_TABS: '.modal-tabs',

  // Modals general
  MODAL: '.modal',
  MODAL_CONTENT: '.modal-content',
} as const;

// Device breakpoints (match app.js MobileDetection)
export const BREAKPOINTS = {
  PHONE_MAX: 430,
  TABLET_MAX: 768,
} as const;

// Keyboard constants (match app.js KeyboardHandler)
export const KEYBOARD = {
  SHOW_THRESHOLD: 150,    // heightDiff > 150px triggers show
  HIDE_THRESHOLD: 100,    // heightDiff < 100px triggers hide
  TYPICAL_IOS_HEIGHT: 336,
  FOCUSIN_DELAY: 400,
  ANIMATION_DELAY: 150,
  RESIZE_DELAY_SHOW: 150,
  RESIZE_DELAY_HIDE: 100,
  ACCESSORY_BAR_HEIGHT: 44,
  TOOLBAR_HEIGHT: 40,
  CONFIRM_TIMEOUT: 2000,
} as const;

// Swipe constants (match app.js SwipeHandler)
export const SWIPE = {
  MIN_DISTANCE: 80,
  MAX_TIME: 300,
  MAX_VERTICAL_DRIFT: 100,
} as const;

// Subagent window constants
export const SUBAGENT = {
  MOBILE_CARD_HEIGHT: 110,
  MOBILE_CARD_GAP: 4,
  MOBILE_CARD_STRIDE: 114,   // height + gap
  TOOLBAR_OFFSET: 40,
  DEFAULT_HEADER_HEIGHT: 36,
} as const;

// Visual regression
export const VISUAL = {
  DEFAULT_THRESHOLD: 0.1,
  MAX_DIFF_PERCENT: 0.5,
  SNAPSHOT_DIR: 'mobile-test/snapshots',
} as const;

// Visual regression breakpoints (width values for screenshot comparison)
export const VISUAL_BREAKPOINTS = [320, 375, 390, 393, 430, 440, 600, 768, 834, 1024] as const;

// Wait times
export const WAIT = {
  DOM_CONTENT_LOADED: 'domcontentloaded' as const,
  PAGE_SETTLE: 3000,
  KEYBOARD_ANIMATION: 200,
  SSE_CONNECT: 1000,
};

// Touch target minimum (WCAG 2.5.5 / Apple HIG)
export const MIN_TOUCH_TARGET = 44;

// Body CSS classes
export const BODY_CLASSES = {
  MOBILE: 'device-mobile',
  TABLET: 'device-tablet',
  DESKTOP: 'device-desktop',
  TOUCH: 'touch-device',
  IOS: 'ios-device',
  SAFARI: 'safari-browser',
  KEYBOARD_VISIBLE: 'keyboard-visible',
} as const;

// Settings localStorage keys
export const STORAGE_KEYS = {
  SETTINGS_MOBILE: 'claudeman-app-settings-mobile',
  SETTINGS_DESKTOP: 'claudeman-app-settings',
  NOTIFICATION_PREFS_MOBILE: 'claudeman-notification-prefs-mobile',
} as const;
