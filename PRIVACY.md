# Privacy Policy — Leeway

_Last updated: 2026-10-16_

Leeway is a Chrome extension that shows how much of your **remaining** usage is
left on Claude, ChatGPT and Gemini, in its popup, toolbar badge, and an optional
floating overlay. This policy explains exactly what it reads, where that stays,
and what it never does.

**Unofficial project.** Leeway is not affiliated with, endorsed by, or
sponsored by Anthropic, OpenAI or Google.

## Short version

- Leeway reads your usage from the services you are **already signed in to** in
  your normal Chrome profile. It does not sign you in or ask for your password.
- Everything it reads stays **on your computer** (`chrome.storage.local`).
- Leeway has **no server of its own** and sends your data to no one. The
  floating overlay runs inside Chrome — there is no separate app to install.
- No analytics, no tracking, no advertising identifiers.

## What Leeway reads

For each service you turn on:

- **Claude / ChatGPT** — Leeway calls the same authenticated usage endpoint the
  service's own usage page uses, with your browser's existing session, and reads
  only the usage limits (remaining percentage and reset time). For ChatGPT it
  also needs a short-lived access token from your signed-in session to make that
  one request; the token is used for that request only and is **never stored,
  logged, or sent anywhere**. Email and account
  identifiers in the response are ignored.
- **Gemini** — Gemini has no usage API, so Leeway reads the numbers already
  shown on an open `gemini.google.com/usage` tab (the current-usage and weekly
  cards). It reads only those usage strings and the "updated N ago" text — not
  the rest of the page, your prompts, or your conversations — and it never opens
  a tab on its own.

Leeway injects a content script **only on a service's usage screen**, never on a
conversation page.

## What Leeway stores

- The latest parsed usage snapshot per service (status, remaining percentages,
  reset times), so the popup and badge can show it.
- Which services you turned on.

All of this lives only in your browser profile, on your device. It is not sent
anywhere. Removing the extension removes it.

## What Leeway never does

- No sign-in automation; no Playwright or separate browser.
- Never collects or stores full page text, prompts, or conversations.
- Never stores or transmits cookies, passwords, or session tokens.
- No external servers, analytics, telemetry, or ads.
- Never weakens site security (it does not strip `X-Frame-Options` or CSP).

## Permissions, and why

- **storage** — keep the latest usage on your device for the popup and badge.
- **alarms** — refresh usage on a 2-minute schedule.
- **tabs** and **scripting** — find a provider's already-open usage tab and read
  the rendered numbers from it (ChatGPT's page fallback, and Gemini), and open
  the floating overlay.
- **activeTab** — when you click "Open overlay", Leeway runs on the tab you are
  viewing just long enough to open the floating overlay window. It reads nothing
  from that page.
- **Site access** to `claude.ai`, `chatgpt.com`, `gemini.google.com` — these are
  **optional** and requested only when you turn that service on.

## Floating overlay

The floating overlay is a small always-on-top window drawn by Chrome itself
(Document Picture-in-Picture) — there is no separate app to install. It shows
the same on-device usage summary the popup shows, and reads nothing from the web
page it is opened over.

## Data deletion

Uninstalling Leeway deletes everything it stored. You can also remove its data
from the extension's entry in `chrome://extensions`.

## Contact

Questions or issues: please open an issue on the project's repository.

## Changes

Material changes to this policy will update the date at the top.
