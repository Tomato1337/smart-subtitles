# Smart Subtitles — notes for coding agents

Desktop player (Tauri 2: Rust backend + React frontend) for learning English from films: bilingual subtitles, LLM translation and highlighting, a tutor chat, Anki cards with movie clips. Linux (developed on Fedora), macOS and Windows. The UI and user-facing strings are Russian; code, comments and agent docs are English.

Two audiences, two documents:

- **Runtime agents** that configure the running app for a user read `src-tauri/src/setup_guide.md`. The app serves it at `http://127.0.0.1:47800/llms.txt` together with the setup API (`/api/setup`, `PATCH /api/setup/config`, …). Point users' agents there; do not duplicate it here.
- **Coding agents** working on this repository read this file. `README.md` is the user-facing manual (Russian).

## Commands

```sh
npm install
npm run tauri dev                                  # dev app; a src-tauri change rebuilds (~15 s) and restarts it
npm run type-check                                 # tsc -b (TypeScript 7)
npm run lint                                       # oxlint src --deny-warnings (no ESLint)
npm test                                           # vitest
cargo test --manifest-path src-tauri/Cargo.toml    # Rust unit tests
npm run build:rpm | build:deb | build:appimage | build:mac | build:windows   # one package each
```

Run all four checks before handing work back. The dev app restart kills the current ffmpeg stream and session.

## Layout

```
src-tauri/src/
  lib.rs            app setup, plugins (single-instance, deep link smartsubs://), command registration
  commands.rs       every #[tauri::command] the UI calls
  server.rs         axum on 127.0.0.1:{server.port}: /api/session (Lampa), /media/* (fMP4 stream), plugin JS
  setup.rs          setup wizard status, agent HTTP API, config validate/merge-patch/apply
  setup_guide.md    agent guide, served as /llms.txt
  config.rs         config.json schema and defaults (serde, camelCase)
  state.rs session.rs  AppState, the open film (one session at a time)
  db.rs             SQLite schema + numbered migrations (PRAGMA user_version)
  notify.rs logs.rs deps.rs poster.rs theme.rs patterns.rs
  proc.rs           finding and starting external tools on every OS (see Conventions)
  media/            ffprobe, ffmpeg stream args (copy / VAAPI tonemap / x264), keyframes, clips
  subs/             parse/clean, sources: torrserver (/subs API), sidecar, embedded (mkv.rs EBML reader), opensubtitles;
                    acquire.rs (source chain), choose.rs (chooser), store.rs, sync.rs (whisper offset)
  llm/              client (OpenAI + Anthropic wire), providers (keys from other agents), tasks (per-task routing),
                    annotate, explain, agent + tools (chat), catalog/cost/usage (prices, tokens)
  asr/              faster-whisper through uv, word alignment
  anki/             AnkiConnect client, note type, field mapping, known-words index, card queue, images, tts
  tutor/            optional tutor add-on API
src/                FEOD layers: common → modules → pages → app
  common/api/tauri.ts      every IPC command (`call`) and event (`AppEvents`); the IPC map
  common/types/ipc.ts      TS mirror of the Rust IPC/config types
  modules/<Name>/index.ts  the only public API of a module
lampa-plugin/smartsubs.js  Lampa plugin; also served by the app at /lampa/smartsubs.js
packaging/arch/PKGBUILD    Arch package, repacked from the release .deb
.github/workflows/release.yml  every package; a v* tag attaches them to one draft release, a manual run only builds artifacts
```

## Conventions

- Frontend follows FEOD (<https://github.com/Sdju/feod>): import other modules only through their `index.ts`; lower layers never import higher ones. `oxlint.config.ts` enforces it.
- TanStack Router (code-based, `src/app/router.tsx`) and TanStack Query; Tailwind 4. Custom typography classes live in `@layer components`, otherwise they override utilities like `font-semibold`.
- IPC is matched by name strings, so grep the name to trace a feature end to end. UI → Rust: `call('<cmd>')` in `src/common/api/tauri.ts` (the only `invoke` besides `log_events` in `eventLog.ts`) reaches `commands::<cmd>`, a `#[tauri::command]` registered in `generate_handler!` in `lib.rs`. Rust → UI: Tauri events (`subs:status`, `annot:progress`, `cards:job`, `config:changed`, …), emitted with `.emit("<name>", …)` and listed with their payload types in `AppEvents` in `tauri.ts`; listen through `onEvent`. Adding or removing either side means changing the other; `ipc_contract` tests in `lib.rs` fail otherwise.
- Errors and warnings the user must see go through `notify::push` (stored, shown in the notification center); transient messages through `notify::info`.
- Logging: `logs::log("<name>", …)` writes `logs/<name>.log` next to `config.json` (`app`, `llm`, `ffmpeg`, `asr`, `events`). Never log secrets; `logs::redact` masks URL userinfo and key-shaped strings, keep it in the path of anything third-party.
- Comments explain why, not what; keep them current when behaviour changes.
- External tools (ffmpeg, ffprobe, uv, omp) start only through `proc::command` (foreground) or `proc::background` (`nice -n 10` on Unix, below-normal priority on Windows; both hide the console window on Windows), and are looked up with `proc::find`/`find_in`, which add `.exe`/`.cmd` on Windows. Never `Command::new("nice")` or a hard-coded `/` path separator. Pass a session source to ffmpeg/ffprobe through `media::input`: ffmpeg does not percent-decode `file://` URLs.
- Platform code is `#[cfg(unix)]`/`#[cfg(windows)]`/`#[cfg(target_os = …)]`. With no Windows machine at hand, check it with `cargo check --target x86_64-pc-windows-gnu` (needs a mingw C compiler, e.g. a `zig cc` wrapper) or a manual run of the release workflow.

## UI kit (m3e)

Components, tokens and motion come from the `m3e` kit (Material 3 Expressive), shared with the English course (УМК): the npm packages `@tomato1337/m3e-tokens` and `@tomato1337/m3e-react`, built from <https://github.com/Tomato1337/m3e>. A plain `npm install` gets them; nothing else needs to be cloned.

- Change or add components in the kit repository (its `AGENTS.md`; `npm run check` there), never as local copies. The app keeps only app-specific styles in `src/app/styles/main.css` (`@layer components`).
- To try a kit change here before it is published: check the kit out at `../m3e`, `npm install && npm run build:packages` there, then `npm link ../m3e/packages/tokens ../m3e/packages/react` here; rebuild the packages after each kit edit, `npm install` returns to the registry versions. `resolve.dedupe` and `server.fs.allow` in `vite.config.ts` and the React `paths` in `tsconfig.app.json` exist for this linked setup.
- Releasing a kit change: publish it from the kit repository (a `v*` tag), then bump both `@tomato1337/m3e-*` versions in `package.json` together with the app change that needs it.
- Layer order is declared once in `main.css`: `@layer theme, base, m3e, components, utilities;`. Tailwind utilities override the kit; no `!important`.
- Dialogs are the kit's `<Dialog>` on a native modal `<dialog>`: no hand-made scrim, `role="dialog"`, `aria-modal`, focus trap or Esc listener. `onClose` is the close request (Esc, back gesture, backdrop with `dismissible`); point it at the safe action. Render dialogs conditionally inside `<Presence>` so closing animates. App hotkeys ignore keys while a `dialog[open]` exists.
- Motion: whatever enters also exits. Conditional UI goes inside `<Presence>` with an `m3e-motion-*` class, or uses `usePresence(open, ref)` when the closed state changes the layout (the player's side panels). Exits are transitions or animations on `[data-closing]` (`animateExit`); never remove an element on a timer copied from CSS. Movement (translate, scale, size, position) needs `prefers-reduced-motion: no-preference` (`motion-reduce:transition-none` on utilities); fades may stay; no global duration kill switch.
- Menus: kit `<Menu>` (popover) anchored to the wrapper of its trigger; the trigger gets `aria-haspopup="menu"` and `aria-expanded`. Icons: kit `<Icon>` (Material Symbols Rounded). Toasts: `toast()` from the kit; warnings and errors: the notification center. The quick-card task is not a toast: `Cards/ui/CardIsland.tsx` (driven by `Presenter` through `islandSurface`) collapses into a pill on the player's top bar, docked by `useCardIslandDock` in `WatchScreen`.

## Browser support

The UI runs in the system web view: WebKitGTK on Linux, WKWebView on macOS, WebView2 (Chromium) on Windows. The floor is WebKitGTK 2.46 / Safari 17.5 and Chromium 123 (`build.target` and `cssTarget` in `vite.config.ts`; an older CSS target makes Lightning CSS rewrite `light-dark()` and breaks the theme). Anything newer is progressive enhancement behind `@supports` or a feature check, with a fallback in the same change. WebKit lacks `overlay`, `closedby`, `requestClose()`, CSS anchor positioning, `interpolate-size` and `@starting-style` on `::backdrop`; the kit already covers those. Check motion and focus in WebKitGTK, which every Linux package uses, not only in Chromium.

## Changing the config

A config field touches several places; all of them must change together:

1. `src-tauri/src/config.rs`: the struct field with `#[serde(default)]` and its default. Old `config.json` files must keep loading.
2. `src-tauri/src/setup.rs`: `validate` for enumerations and formats; `SECRETS` if the value is a key or password (it is then masked as `***` in the agent API); `status` if a wizard step depends on it.
3. `src-tauri/src/setup_guide.md`: a row `| \`dotted.path\` | type | default | meaning |` in «Config fields». The test `setup::tests::agent_guide_documents_every_config_field` fails when a field has no row.
4. `src/common/types/ipc.ts` and the settings UI in `src/modules/Settings/`.
5. `README.md` («Настройка») when users need to know about it.

`setup::apply` is the only path that saves and applies a config (UI and agent API alike); add any re-initialization a field needs there (see the VAAPI self-test and the Anki index refresh).

## Changing the database

Never edit `SCHEMA` for existing installs: append `MIGRATION_<n>` in `db.rs`, run it under `if v < n` and bump `user_version` to `n`. Document the version in a comment like the others.

## Pitfalls

- AnkiConnect closes the socket after each answer; requests go with `Connection: close`.
- `ffprobe` on a cold torrent can take up to 120 s (the timeout); keep it off paths the UI waits on.
- The ffmpeg stream is a live fMP4 pipe: no byte ranges except from 0; seeking restarts ffmpeg.
- The embedded-subtitle reader only appends cues at the tail, so `cue.idx` stays the start-time rank everything keys on.
- Annotation batches are 40 cues (`annotate::BATCH`, mirrored in `Watch/AnnotGate.tsx`).
- macOS apps started from Finder get a minimal `PATH`; `lib.rs` appends the Homebrew prefixes. On Windows a tool installed while the app runs is found only after a restart (`PATH` is inherited at start).
- `smartsubs://` is registered by the rpm/deb/Arch `.desktop` file; an AppImage and the Windows build register it themselves at every start (`register_all` in `lib.rs`).
- The machine may have `http_proxy` set; reqwest reaches loopback services directly through `no_proxy`.

## Files on the user's machine

Linux paths (macOS: `~/Library/Application Support/smart-subtitle/` and `~/Library/Caches/smart-subtitle/`; Windows: `%APPDATA%\smart-subtitle\` and `%LOCALAPPDATA%\smart-subtitle\`):

- `~/.config/smart-subtitle/config.json` (mode 600 on Unix, holds keys), `data.db`, `logs/`
- `~/.cache/smart-subtitle/`: subtitles, clips, card images, posters, the whisper `uv` environment, `models-dev.json`

Never print or commit the contents of `config.json`; refer to fields by path.
