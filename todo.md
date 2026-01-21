# Claudeman TODO List

## Completed

- [x] Memory leaks intensive check - Fixed timer tracking in session.ts, proper cleanup in server.ts
- [x] Security hardening - Added input validation, command injection prevention, path traversal protection
- [x] Performance optimization - Pre-compiled regex patterns, event debouncing, buffer management
- [x] Reliability improvements - Proper cleanup on session exit, listener cleanup
- [x] TUI parity with web interface:
  - [x] Shell mode support (h key in cases view)
  - [x] Multi-start (m key, 1-20 sessions at once)
  - [x] Respawn toggle (Ctrl+R)
  - [x] Session rename API support
  - [x] Selected item display in start screen
  - [x] Help overlay with all shortcuts
  - [x] Web server auto-detection and startup
    - Prompts to start web server if not running
    - `--with-web` flag for automatic startup (no prompt)
    - `--no-web` flag to skip check entirely
- [x] Documentation updates - Updated CLAUDE.md with TUI shortcuts

## Ongoing (Long-term stability)

- [ ] Monitor for edge cases during extended runtime
- [ ] Consider implementing graceful degradation for API failures
- [ ] Add metrics/logging for long-running session health

## Future Enhancements

- [ ] TUI: Add inline session rename UI (currently API only)
- [ ] TUI: Add task panel for background tasks
- [ ] TUI: Add scheduled runs display
- [ ] TUI: Add auto-compact/auto-clear configuration UI
- [ ] Consider WebSocket for TUI instead of polling (reduce latency)
