/**
 * @fileoverview The "model on this Mac" card of the welcome screen and its row in App Settings.
 *
 * SKELETON: this file holds no code yet. It will read `GET /api/local-model` (hardware of the
 * machine the server runs on, the recommendation, the catalogue date) and show, read-only:
 *  - the hardware line (chip, memory, free disk);
 *  - the verdict: the headline and notes the server sent, then the pick with its numbers
 *    (model, harness, context, memory need against the budget, download size, speed);
 *  - the other models that fit, each with its fit and speed label;
 *  - one line saying that setting the model up from Codeman is the next step and is not built
 *    yet.
 *
 * Rules:
 *  - Read-only: no button here downloads, installs or writes anything.
 *  - Hidden when the server is not on macOS (`recommendation.reason` is `not-macos`), when the
 *    request is refused (a non-admin in multi-user mode gets a 403) and after the user dismissed
 *    the card on this device (a localStorage key, never a server setting).
 *  - Every dynamic string goes in through `textContent`. Model, harness and chip names are
 *    someone else's text and carry `data-i18n-skip`.
 *  - Names and labels come from the payload: this file holds no list of models or harnesses and
 *    never compares a CLI id with a literal.
 *  - Sizes are printed exactly as sent (`needGb`, `downloadGb`, `budgetGb`, `memGb`,
 *    `freeDiskGb`: decimal GB as text). Bytes are never divided here.
 *  - A sentence the server chose arrives as `{ text, vars }` and goes through
 *    `codemanT(text, vars)`; this file's own strings are literals in its translator call, so the
 *    i18n test can harvest them. Both kinds need a zh-CN entry in i18n.js.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp)
 * @dependency api-client.js (_api)
 * @dependency i18n.js (codemanT, optional)
 * @loadorder 12.59 of 16, after edit-history-ui.js, before entrance-animations.js
 */
