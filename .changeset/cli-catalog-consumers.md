---
'aicodeman': minor
---

`install.sh` and the Docker agent image now read the shipped CLI catalogue instead of
hand-maintaining their own lists.

Adding a CLI to `src/config/cli-registry/stock.ts` and running
`npm run generate:cli-catalog` wires it into the installer's detection, its install menu and
its closing reminder, and into the agent image's npm layer. Previously each of those was a
separate hand-written list that had to be kept in step and was not: upstream `b6d0f1fa` is
"wire OMP into install.sh's CLI detection (it had none)", where a user with only `omp`
installed was told no AI CLI was found and offered Claude Code, and the section comment above
that code named six of the nine CLIs.

The generator emits two committed artifacts, because neither consumer can import TypeScript:
`config/clis.stock.json` for the Docker build, and a marked block inside `install.sh` itself,
which runs via `curl | bash` before any checkout exists. The embedded copy is the FULL
catalogue: an earlier attempt fetched it and fell back to a hardcoded two-CLI list, degrading
silently on an empty response, and there is no degraded mode to fall into now. An optional,
opt-in refresh (`CODEMAN_CLI_CATALOGUE_URL` or `CODEMAN_REFRESH_CLI_CATALOGUE=1`) warns loudly
on all three failure shapes.

**Trust model is unchanged and now mechanical.** The server still never executes an entry's
install command. `install.sh` executes only commands embedded in itself — same file, same TLS
fetch, same commit as the `curl | bash` line that fetched it — and nothing pulled from the
network at install time is ever run: the two live in separate arrays and a test asserts the
refresh cannot write the executable one.

**The agent image respects `enabled`.** The generated catalogue carries that flag, so a CLI
shipping disabled is no longer baked into every image. It reads the stock catalogue rather than
the merged registry, so a user's `~/.codeman/clis.json` cannot change what is inside an image
tagged `codeman/agent:base`.

User-visible changes, all in the installer:

- The install menu is built from the catalogue, so it offers every enabled CLI that is not installed and ships an install command — five rather than the previous fixed two. Gemini had a command in the registry and appeared in no list in the script at all.
- Its entries use the registry's labels ("Claude" rather than "Claude Code"), the same trade already made for `codeman doctor` rows. A suffix map would just be the hand-maintained list again.
- On a `wget`-only host the menu prints the commands instead of running them. The registry's commands call `curl`, whereas the two literals they replace went through `download_to_stdout`; rewriting `curl` to `wget` inside a string about to be executed is the wrong instinct.
- `CODEMAN_NONINTERACTIVE=1` still defaults to Claude Code, unchanged.

`install.sh` remains bash 3.2 compatible (macOS ships it): parallel indexed arrays with
offset/length windows instead of delimiters, no associative arrays, namerefs, `mapfile` or
here-strings. CI now runs `bash -n`, executes the script inside a real `bash:3.2` container —
which is what catches expanding an empty array under `set -u`, a runtime abort `bash -n` cannot
see — and checks the generated artifacts are in sync.

`docker/server.Dockerfile` is deliberately untouched; its narrower CLI list is now asserted as
a declared omission list so the divergence is visible rather than accidental.
