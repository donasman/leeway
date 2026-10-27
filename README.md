# Leeway

> **Status: preparing the first Chrome Web Store release.**
> The goal is a standalone Chrome extension that shows the **remaining** Claude, ChatGPT and Gemini usage in its popup and toolbar badge. An always-on-top floating overlay is built in via Chrome's Document Picture-in-Picture — no separate app to install.
>
> Unofficial project. Not affiliated with Anthropic, OpenAI or Google.

The extension uses the normal Chrome profile that is already signed in. It does not use Playwright, automate sign-in, or copy cookies/passwords out of the browser.

| Service | How usage is read | State |
|---|---|---|
| Claude | claude.ai authenticated internal usage endpoint | working |
| ChatGPT | chatgpt.com internal usage endpoint (the one its Settings > Usage page reads) | working — confirmed in a logged-in Chrome on 2026-10-15 (an account with a 30-day limit); accounts with 5-hour/weekly limits not yet seen |
| Gemini | gemini.google.com/usage page, read from an already-open tab | working — reading confirmed in a logged-in Chrome on 2026-10-16; needs that page open |

None of these are public, stable APIs. They may change without notice.

## Install from source (load unpacked)

The extension keeps the latest usage in its own storage and shows it in its popup and toolbar badge.

1. Open chrome://extensions, enable Developer mode, and choose **Load unpacked**.
2. Select this project's extension folder. If an older copy is loaded, remove or reload it.
3. In the extension popup, turn on Claude, ChatGPT and/or Gemini and allow the site permission it asks for. Gemini is read from an open gemini.google.com/usage tab — keep that page open (the **Gemini 사용량** button opens it) for its values to refresh.
4. Keep the normal Chrome profile signed in to those services. Values refresh every 2 minutes; **새로고침** (refresh) in the popup reads them again right away.

The floating overlay is built into the extension (click **Open overlay** in the popup); it uses Chrome's Document Picture-in-Picture, so there is no separate app to install.

## Popup

For each service that is turned on, the popup shows the remaining percentage of each limit and when it resets. The 5-hour limit is the large number; an account without a 5-hour limit (e.g. ChatGPT Pro) shows its weekly limit there instead. 0% is shown as 0%; a value that could not be read is `?`.

- The plan (e.g. `Max 5x`, `Plus`) is shown next to the service name when the service reports it. Gemini does not, so it has none.
- One claude.ai sign-in can belong to several organizations (a personal plan and a Team workspace, say). Each one with chat limits gets its own block, named by its plan, so you can see which has how much left. The first one is the main value (the toolbar badge and the overlay's collapsed line).

- When a read fails, the last good values stay visible, dimmed, with how old they are. Hover the status label for the failure reason.
- Values older than 6 minutes (three missed refreshes) are dimmed; a good read that old is marked 오래됨 (stale).
- Reset times come from the services as exact times. Only ChatGPT's page fallback gives relative "4시간 20분 후 초기화"-style text; the popup counts that down (in the current UI language) from when it was read.
- Turning a service on asks Chrome for that site's permission. If the popup closes while Chrome asks, allowing it still turns the service on.
- The UI is available in English, Korean, Spanish, Chinese (Simplified and Traditional) and Japanese. Chrome picks it from your browser language, falling back to English.

## Other Chrome profiles (optional)

To see several Claude (or ChatGPT, Gemini) accounts at once, sign in to each in its own Chrome profile and install Leeway in each. With the **Leeway helper** installed, every profile's popup and overlay also show the other profiles' remaining usage.

1. Download `leeway-helper.exe` and run it once. It registers itself for your Windows user (no administrator rights) and copies itself to `%LOCALAPPDATA%\Leeway\helper`.
2. In each profile's popup, turn on **Other Chrome profiles** (Chrome asks for the "communicate with cooperating native applications" permission) and give the profile a name, e.g. `Work`.
3. Each profile then sends its own values on every refresh and shows the others' under its own. The toolbar badge still shows only this profile.

Only the values the popup shows travel, through a file on your computer: no cookies, tokens or email addresses, and nothing leaves the computer. Remove it with `leeway-helper.exe uninstall`. Building the helper: see [helper/README.md](helper/README.md).

## Toolbar badge

The extension icon shows the lowest main value among the services that are turned on, as a number without `%` (e.g. `70`). Its colour follows that number: green from 50, orange from 20 to 49, red below 20, grey when it is more than 6 minutes old. `?` means services are on but none has a value yet; no badge means none is on. Hover the icon for each service's value and reset time.

## ChatGPT

What is shown is what ChatGPT's Settings > Usage page shows: the plan limits shared by Codex, Work, workspace agents and ChatGPT for Excel. As that page says, ordinary chat conversations are not counted there.

Like Claude, ChatGPT is read in the background — no tab needs to be open. The extension asks chatgpt.com for a short-lived access token (with the browser's own sign-in) and then calls the usage endpoint ChatGPT's Settings > Usage page uses. The token is used for that one request and kept nowhere: not in extension storage, logs, or anything that leaves the extension. Of the answer, only the limit windows are read; the email and account ids in it are ignored.

Each limit is named by its length: 5 hours, weekly, or monthly (30 days, as on some accounts). The 5-hour limit is the main value; an account without one shows its weekly limit, and an account with only a monthly limit shows that. If a window's length or value can't be read, the read counts as failed rather than guessing which one is the main value.

If that endpoint fails (it is unofficial and may change), and a Settings > Usage page happens to be open, the extension reads that page instead. It never opens a tab for this and never reads conversation tabs, even with the usage dialog open over a conversation. From that page only the parsing steps are kept, not its text.

## Overlay

Click **Open overlay** in the popup (on a normal http/https tab) to open a small always-on-top window through Chrome's Document Picture-in-Picture — no separate app to install (needs Chrome 116+).

- It shows the same remaining-usage bars as the popup and refreshes live.
- Click the overlay to collapse it to a single line; click again to expand. The window resizes to match.
- It stays on top of other windows while Chrome runs. It belongs to the tab you opened it from, so it closes when that tab closes, and Chrome shows that page's address in the overlay's title bar.

## Languages

The UI ships in English (default), Korean, Spanish, Chinese (Simplified and
Traditional) and Japanese, under `extension/_locales/`. Chrome selects the
locale from the browser language and falls back to English. Taiwan and Hong
Kong (`zh_TW`) get Traditional Chinese; other Chinese locales get Simplified.

## Privacy

Leeway reads your usage from the sessions you are already signed in to, keeps it
on your device (`chrome.storage.local`), and sends it to no one. It has no
server, no analytics, and never stores page text, cookies, passwords, or
session tokens. See [PRIVACY.md](PRIVACY.md) for the full policy, including what
each permission is for.

## License

[MIT](LICENSE).

## Local checks

```
npm install          # once — test tooling only (jsdom)
npm test             # extension tests: parsers, snapshot, view, background, popup, ChatGPT parser, locales
node --check extension/background.js
```
