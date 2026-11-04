# Smart Subtitles — guide for agents

Smart Subtitles is a Linux, macOS and Windows desktop player for learning English from films and series. It shows English subtitles with a Russian translation, highlights idioms, phrasal verbs and grammar patterns, explains any phrase in context, runs a tutor chat about the film and writes Anki cards with a movie clip, audio and an AI picture. This guide explains how the app works and lets you, an agent, inspect and change its settings on behalf of the user.

The API works only while the app is running; if a request fails with a connection error, ask the user to start Smart Subtitles. Base URL: `http://127.0.0.1:{port}`. Send requests without an `Origin` header (plain `curl`), otherwise they are rejected with 403; the `Host` must be `127.0.0.1:{port}` or `localhost:{port}`.

## How to help the user

1. Run `curl -s http://127.0.0.1:{port}/api/setup` and show the user which steps are missing (`steps[].done == false`), starting with `importance: "required"`.
2. For the LLM step, first call `GET /api/setup/llm/providers`. If a provider has `hasKey: true`, offer to use it and send `PATCH {"llm":{"source":"<source>","provider":"<id>","model":"<one of models>"}}`. Otherwise ask the user for an API key and send `{"llm":{"source":"","baseUrl":"…","apiKey":"…","api":"openai"|"anthropic","model":"…"}}`. Defaults: DeepSeek at `https://api.deepseek.com`, model `deepseek-flash`.
3. After every LLM patch, check `GET /api/setup/llm/models`: a 502 means the key or the base URL is wrong.
4. Talk to the user in their language (the app UI is Russian). Ask for secrets, never repeat them in your answers and never log them. `***` in a GET response means "a value is set".
5. Change only what the user asked for. The `PATCH` response carries the new `status`; read it instead of guessing whether a step is done now.

## How the app works

- **Opening a film.** The Lampa plugin (`lampa-plugin/smartsubs.js`) sends `POST /api/session` with the TorrServer stream URL, title, season/episode, TMDB/IMDb ids, subtitle files of the torrent and the playlist; the browser call carries the Lampa `Origin`, which must be listed in `lampa.origins`. If the app is not running, the plugin starts it through the `smartsubs://` link. The user can also open a file from disk on the home screen.
- **Video.** `ffprobe` reads the streams, `ffmpeg` remuxes the video into fragmented MP4 for the built-in MSE player: H.264 is copied, HDR is tone-mapped to SDR through VAAPI (`ffmpeg.vaapiDevice`, Linux only), other codecs are re-encoded, audio becomes AAC. Nothing is downloaded in full.
- **Subtitles.** English subtitles come from the first source in `subtitles.sources` that has them:
  - `torrserver`: subtitle files inside the torrent, through TorrServer's `/subs` API (MatriX.147+).
  - `sidecar`: subtitle files Lampa passed with the video; for a local file, `.srt`/`.vtt`/`.ass` files next to it whose name starts with the video's name.
  - `embedded`: a text track inside the video. From a stream, only the subtitle blocks of an MKV are read, block by block through HTTP Range requests; the user first sees how much TorrServer will download and confirms. From a file on disk, ffmpeg extracts the whole track at once, with no confirmation (any container; bitmap tracks such as PGS/VobSub are skipped).
  - `opensubtitles`: search by file hash and TMDB id (season/episode for series); needs `opensubtitles.apiKey`.
  The result is stored per film, so a film opens with the same subtitles next time. In the player, «Выбрать субтитры…» lists every candidate and switches between them; «Загрузить файл…» in that dialog takes a local file. A timing offset is found automatically with faster-whisper (run through `uv`), and the user can adjust it by hand.
- **Dialog analysis.** The LLM translates every line and marks idioms, phrasal verbs, collocations, slang, reductions and the 48 grammar patterns, in batches of 40 lines, starting from where the user is watching. Before a film's analysis starts, the app asks for consent and shows the token estimate; «Рассчитать стоимость» turns it into dollars (from the price catalog, or a guess by the `cost` task). «Запомнить для этой модели» sets `annot.auto` and `annot.rememberedModel`, so later films start without the question while the analysis model stays the same. The player then waits until the lines around the start point are analyzed («Пропустить» starts at once); the rest continues in the background.
- **LLM tasks.** Every LLM call belongs to a task: `annotate` (dialog analysis), `explain` (explanation of a clicked phrase), `draft` (Anki card draft), `chat` (tutor chat with tools), `cost` (price guess when the catalog lacks one). By default all of them use the main `llm` connection; `llmTasks.<task>` points one task at another provider, model or reasoning effort. Tokens and dollars of every request are recorded per film.
- **Providers from other agents.** `llm.source` / `llmTasks.<task>.source` reference a provider configured in another coding agent: `omp`, `opencode`, `claude`, `codex`, `crush`, `qwen`, `goose` or `gemini`. Only the reference is stored; the base URL and key are re-read from that agent's files on every start and every save, so a rotated key is picked up. Only API keys are imported, never OAuth or subscription logins.
- **Anki.** Cards are written directly through AnkiConnect (`anki.url`); the deck and the built-in note type «Smart Subtitles — Vocab» are created on the first card. A card gets the word, translation, cloze sentence, the movie clip, word/sentence audio (edge-tts through `uv`) and an optional AI picture (`images.*`). Adding runs in a background queue. Words already in the indexed decks (`anki.indexDecks`) are highlighted in the subtitles.
- **Tutor.** An optional companion service (`tutor.*`): CEFR level, script import, its own image settings. Everything works without it.
- **Applying settings.** Every change is saved to `config.json` (mode 600) and applied at once; the UI shows a toast for changes made by an agent. Only `server.port` needs a restart.

## System dependencies

The `deps` step of `/api/setup` reports the tools the app shells out to. If it is not done, `ffmpeg`/`ffprobe` are missing and video cannot play: show the user the step `hint`, which contains the install command for their OS, and ask before running it yourself. `uv` (subtitle auto-sync and the audio on cards) is optional; when it is missing the step stays done but mentions it.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /llms.txt` | This guide. |
| `GET /api/setup` | Setup status: `steps` (`id`, `title`, `importance`, `done`, `hint`, `fields`), `complete`, `port`, `guideUrl`, `configPath`, and the current `config` with secrets masked. |
| `PATCH /api/setup/config` | Merge-patch the config; returns `restartRequired` and the new `status`. Errors are 400 with `{"error": "…"}`. |
| `GET /api/setup/llm/providers` | LLM providers already configured in other coding agents, without keys: `source`, `id`, `label`, `api`, `baseUrl`, `hasKey`, `file`, `models`. |
| `GET /api/setup/llm/models` | Live model list for the main `llm` connection (`{"models": […]}`); 502 when the provider rejects the request. |
| `GET /api/health` | `{"ok": true}` while the app runs. |

```sh
curl -s http://127.0.0.1:{port}/api/setup
curl -s http://127.0.0.1:{port}/api/setup/llm/providers
curl -s http://127.0.0.1:{port}/api/setup/llm/models
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"opensubtitles":{"apiKey":"…"}}' http://127.0.0.1:{port}/api/setup/config
```

Setup steps, in wizard order: `deps` and `llm` are required; `opensubtitles` and `lampa` are recommended; `anki` is optional. `complete` is true when every required step is done.

## Patch rules

JSON Merge Patch (RFC 7386): objects merge key by key, arrays are replaced as a whole, `null` resets a field to its default value. An unknown field is rejected with 400 and its dotted path. The string `***` in a secret field means "keep the stored value", so a config object from GET can be sent back. `restartRequired: true` appears only when `server.port` changed. Every change applies immediately and the app's UI updates itself.

The patch is validated as a whole; a rejected patch changes nothing. Checked: `server.port` 1–65535; `learner.cefr` one of A1–C2; `lampa.origins` entries are bare origins; `anki.url` is http(s); `anki.deck` and `anki.noteType` are not empty; `anki.fields` values are known sources; `anki.sentenceAudio` and `images.backend` are known values; `subtitles.sources` entries are known and unique; a task with its own `source` names a `model`.

Examples:

```sh
# Use a provider from omp for the chat only, with medium reasoning
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"llmTasks":{"chat":{"source":"omp","provider":"anthropic","model":"claude-sonnet-4-5","effort":"medium"}}}' \
  http://127.0.0.1:{port}/api/setup/config
# Send the chat back to the main connection
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"llmTasks":{"chat":null}}' http://127.0.0.1:{port}/api/setup/config
# Allow a Lampa instance and prefer OpenSubtitles over files inside the torrent
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"lampa":{"origins":["https://lampa.example.com"]},"subtitles":{"sources":["opensubtitles","torrserver","sidecar","embedded"]}}' \
  http://127.0.0.1:{port}/api/setup/config
```

Take provider ids and model names from `GET /api/setup/llm/providers`; the ones above are examples.

## Config fields

`<task>` is one of `annotate`, `explain`, `draft`, `chat`, `cost`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `server.port` | number | `47800` | Port of the local HTTP server; 1–65535. A change needs an app restart. |
| `lampa.origins` | string[] | `[]` | Origins of Lampa instances allowed to open films in the player. **Without this the plugin gets 403.** Each entry is an origin without a path or trailing slash. |
| `llm.source` | string | `""` | `""` for a manual connection, otherwise the agent the provider comes from (`omp`, `opencode`, `claude`, `codex`, `crush`, `qwen`, `goose`, `gemini`). |
| `llm.provider` | string | `""` | Provider id inside `llm.source`. |
| `llm.model` | string | `deepseek-flash` | Model name. |
| `llm.baseUrl` | string | `https://api.deepseek.com` | API root for a manual connection. |
| `llm.apiKey` | string | `""` | API key for a manual connection; `DEEPSEEK_API_KEY` is used when empty. |
| `llm.api` | string | `openai` | Wire protocol of a manual connection: `openai` or `anthropic`. |
| `llmTasks.<task>.source` | string | `""` | `""`: the task uses the main `llm` connection; otherwise an agent name as in `llm.source`. |
| `llmTasks.<task>.provider` | string | `""` | Provider id inside the task's `source`. |
| `llmTasks.<task>.model` | string | `""` | Model of the task; `""` means `llm.model` and is allowed only while `source` is `""`. |
| `llmTasks.<task>.effort` | string | `off` | Reasoning effort: `off`, `low`, `medium`, `high`. |
| `annot.auto` | bool | `true` | Start the dialog analysis without asking while the analysis model equals `annot.rememberedModel`. |
| `annot.rememberedModel` | string | `""` | The analysis model the user trusted, written by the app on «Запомнить для этой модели»; `""` means nothing remembered. |
| `opensubtitles.apiKey` | string | `""` | OpenSubtitles key; enough on its own. |
| `opensubtitles.username` | string | `""` | Optional; a login raises the daily download quota. |
| `opensubtitles.password` | string | `""` | Optional; used together with the login. |
| `subtitles.sources` | string[] | `["torrserver","sidecar","embedded","opensubtitles"]` | Order of automatic subtitle sources (see «How the app works»); `[]` turns the automatic search off. |
| `torrserver.baseUrl` | string | `""` | TorrServer address when it sits behind a Basic-auth proxy. |
| `torrserver.username` | string | `""` | Basic-auth login; injected only into URLs under `baseUrl`. |
| `torrserver.password` | string | `""` | Basic-auth password. |
| `anki.url` | string | `http://127.0.0.1:8765` | AnkiConnect address; Anki must be running with the AnkiConnect add-on. |
| `anki.deck` | string | `Learning English` | Deck the app writes cards into; created on the first card. |
| `anki.noteType` | string | `Smart Subtitles — Vocab` | Note type; the built-in one is created and extended by the app, any other is used as is. |
| `anki.fields` | object | `{}` | Anki field name → source id: `word`, `translation`, `wordType`, `clozeGap`, `clozeRaw`, `sentence`, `sentenceTranslation`, `image`, `wordAudio`, `sentenceAudio`, `clip`, `clipText`, `clipSource`; `""` leaves the field empty. A missing field is mapped by name. Any field name is accepted. |
| `anki.tags` | string | `vocab smartsubs smartsubs::{film}` | Tags of every card; `{film}` becomes the film slug. |
| `anki.indexDecks` | string[] | `["*"]` | Decks the known-words index reads; `["*"]` is every deck, `[]` only `anki.deck`. |
| `anki.indexFields` | object | `{}` | Note type → `{word, translation}` field override for the index; any note type name is accepted. |
| `anki.tts` | bool | `true` | Word audio through edge-tts. |
| `anki.ttsVoice` | string | `en-US-GuyNeural` | edge-tts voice. |
| `anki.sentenceAudio` | string | `none` | `none`, `clip` (sound of the movie clip) or `tts` (synthesized). |
| `anki.clip` | bool | `true` | Cut the movie clip at all; `false` empties `Clip`/`ClipText`/`ClipSource` and disables `sentenceAudio: "clip"`. |
| `anki.syncAfterAdd` | bool | `true` | Sync with AnkiWeb after cards are added. |
| `images.backend` | string | `none` | `none`, `openai`, `runware`, `gemini` or `omp`. |
| `images.style` | string | `""` | Appended to every prompt as `. Style: …`. |
| `images.openai.baseUrl` | string | `https://api.openai.com/v1` | OpenAI-compatible image endpoint root. |
| `images.openai.apiKey` | string | `""` | Key for that endpoint. |
| `images.openai.model` | string | `gpt-image-1` | Model name. |
| `images.openai.size` | string | `1024x1024` | Requested size. |
| `images.runware.apiKey` | string | `""` | Runware key. |
| `images.runware.model` | string | `runware:400@2` | Runware model. |
| `images.gemini.apiKey` | string | `""` | Google AI Studio key. |
| `images.gemini.model` | string | `gemini-2.5-flash-image` | `gemini-*-image` or `imagen-*`. |
| `images.omp.model` | string | `""` | omp image model; empty means omp's image role. |
| `images.omp.agentModel` | string | `anthropic/claude-haiku-5-5` | Agent omp runs `generate_image` through. |
| `tutor.enabled` | bool | `false` | Optional add-on: CEFR level, script import, its own image settings. |
| `tutor.root` | string | `~/tutor` | Checkout of tutor; only used when the add-on is on. |
| `tutor.apiUrl` | string | `http://127.0.0.1:4820` | Tutor API address. |
| `tutor.useImageSettings` | bool | `true` | Take the image backend from tutor instead of `images.*`. |
| `learner.cefr` | string | `A2` | Learner level, one of `A1`, `A2`, `B1`, `B2`, `C1`, `C2`; it decides what gets highlighted and how it is explained. |
| `ffmpeg.vaapiDevice` | string | `/dev/dri/renderD128` | VAAPI device for hardware decoding and HDR tone mapping on Linux; unused on macOS and Windows. |

Secret fields, masked as `***` in GET: `llm.apiKey`, `opensubtitles.apiKey`, `opensubtitles.password`, `torrserver.password`, `images.openai.apiKey`, `images.runware.apiKey`, `images.gemini.apiKey`.

Settings that live in the UI only (browser `localStorage`, not reachable through this API): rebound hotkeys, subtitle layer toggles, the Anki highlight mode, whether the first-run wizard and the player tour were seen.

## Where to get keys

- DeepSeek: <https://platform.deepseek.com/api_keys>.
- OpenSubtitles: <https://www.opensubtitles.com/consumers>.
- Lampa: add the plugin in Lampa under «Настройки → Расширения → Добавить плагин». For Lampa opened over http the plugin is served at `http://127.0.0.1:{port}/lampa/smartsubs.js` (over https it must be hosted on the user's own server). Then add the Lampa origin to `lampa.origins`.
- Anki: install the AnkiConnect add-on (code `2055492159`) and keep Anki running; the app writes cards itself through it.
- Card images: OpenAI (`https://platform.openai.com/api-keys`), Runware (`https://runware.ai`), Google AI Studio (`https://aistudio.google.com/apikey`) or omp (`images.backend: "omp"`, no key).
- Tutor is optional: a checkout of the service at `tutor.root` with its API at `tutor.apiUrl`.

## Files and troubleshooting

`configPath` from `/api/setup` is the config file; the other files sit next to it (Linux: `~/.config/smart-subtitle/`, macOS: `~/Library/Application Support/smart-subtitle/`, Windows: `%APPDATA%\smart-subtitle\`). Prefer the API to editing `config.json` by hand: a hand edit takes effect only after a restart and is not validated.

| File | Contents |
|---|---|
| `config.json` | Settings; mode 600 on Linux and macOS. |
| `data.db` | SQLite: films and positions, subtitles, analysis, explanations, chat, card proposals, notifications, LLM usage. |
| `logs/app.log` | Sessions, subtitles, Anki, settings. |
| `logs/llm.log` | LLM requests and errors (bodies are logged with secrets redacted). |
| `logs/ffmpeg.log` | ffmpeg commands and stderr per session. |
| `logs/asr.log` | Whisper subtitle sync. |
| `logs/events.log` | HTTP requests and UI events. |

The cache (subtitles, clips, card images, posters, the Whisper environment, the models.dev price index) is in `~/.cache/smart-subtitle/` on Linux, `~/Library/Caches/smart-subtitle/` on macOS and `%LOCALAPPDATA%\smart-subtitle\` on Windows.

| Symptom | Check |
|---|---|
| Lampa says the app refused the film (403) | The Lampa origin is missing from `lampa.origins`, or has a path or trailing slash. |
| No translation or highlights | The `llm` step of `/api/setup`; then `GET /api/setup/llm/models`; then `logs/llm.log`. |
| A task fails while others work | Its `llmTasks.<task>` provider: `GET /api/setup/llm/providers` must still list it with `hasKey: true`. |
| No subtitles found | `opensubtitles.apiKey`, `subtitles.sources` not empty; `logs/app.log`. |
| Video does not start | The `deps` step (ffmpeg/ffprobe); `logs/ffmpeg.log`; for a torrent behind a proxy, `torrserver.*`. |
| Cards fail | Anki running with AnkiConnect at `anki.url`; the image backend key; `logs/app.log`. |
