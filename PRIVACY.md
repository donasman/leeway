# Privacy Policy — Leeway

_Last updated: 2026-10-28_

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
- The optional **Other Chrome profiles** feature uses a small helper program on
  your own computer. It passes usage numbers between your Chrome profiles
  through a file on your computer, and nothing leaves your computer.
- No analytics, no tracking, no advertising identifiers.

## What Leeway reads

For each service you turn on:

- **Claude / ChatGPT** — Leeway calls the same authenticated usage endpoint the
  service's own usage page uses, with your browser's existing session, and reads
  only the usage limits (remaining percentage and reset time) and which plan the
  account is on, shown as a fixed product name such as "Max 5x" or "Plus". For
  ChatGPT it also needs a short-lived access token from your signed-in session to
  make that one request; the token is used for that request only and is **never
  stored, logged, or sent anywhere**. Email and account identifiers in the
  response are ignored.
- **Claude organizations** — one claude.ai sign-in can belong to several
  organizations (for example a personal plan and a Team workspace). Leeway reads
  the usage of each organization that has chat limits, so you can see how much is
  left in each. An organization's id is used only to request its usage and is
  not stored; organization names (which can contain your email address) are not
  read.
- **Gemini** — Gemini has no usage API, so Leeway reads the numbers already
  shown on an open `gemini.google.com/usage` tab (the current-usage and weekly
  cards). It reads only those usage strings and the "updated N ago" text — not
  the rest of the page, your prompts, or your conversations — and it never opens
  a tab on its own. If that tab sits in the background with numbers more than five minutes old, or
  Chrome put it to sleep, Leeway reloads it (never while you are looking at it)
  and keeps it from being unloaded.

Leeway injects a content script **only on a service's usage screen**, never on a
conversation page.

## What Leeway stores

- The latest parsed usage snapshot per service (status, remaining percentages,
  reset times, the plan name, and for Claude one entry per organization), so the
  popup and badge can show it.
- Which services you turned on.
- Where you last left the Leeway window (its position and size on screen), so
  it reopens there.

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
- **alarms** — refresh usage on a 1-minute schedule.
- **scripting** — read the rendered numbers from a provider's already-open usage
  tab (ChatGPT's page fallback, and Gemini). Leeway finds that tab through the
  site access below; it does not ask for the "tabs" permission, so it sees the
  address of a tab only on the sites you turned on.
- **Site access** to `claude.ai`, `chatgpt.com`, `gemini.google.com` — these are
  **optional** and requested only when you turn that service on.
- **nativeMessaging** — **optional**, requested only when you turn on "Other
  Chrome profiles". It lets Leeway talk to the Leeway helper on your computer.

## Floating overlay

The floating overlay is a small always-on-top window drawn by Chrome itself
(Document Picture-in-Picture) — there is no separate app to install. "Open
overlay" opens a small Leeway window, a page of the extension itself, and the
overlay opens from there; nothing is injected into the tab you are viewing, and
no web page is involved. It shows the same on-device usage summary the popup
shows.

## Other Chrome profiles (optional, off by default)

If you use several Chrome profiles (for example one per Claude account), you can
see all of their usage in one popup and overlay. This needs the Leeway helper, a
small program you install yourself on Windows (`leeway-helper.exe`).

- **What each profile sends to the helper**: the same values its popup shows —
  remaining percentages, reset times, the plan name — plus the name you give
  the profile (e.g. "Work") and a random id Leeway made for that profile.
- **What it never sends**: cookies, passwords, session or access tokens, email
  addresses, organization names, page text or conversations.
- **Where it goes**: the helper keeps the entries in one file on your computer,
  `%LOCALAPPDATA%\Leeway\profiles.json`, so your other profiles can read them.
  The helper has no network access of its own and sends nothing anywhere.
- **How long**: an entry is replaced on every refresh. Turning the feature off in
  a profile removes that profile's entry; an entry not refreshed for 7 days is
  removed; `leeway-helper.exe uninstall` removes the file and the helper.

## Data deletion

Uninstalling Leeway deletes everything it stored in Chrome. You can also remove
its data from the extension's entry in `chrome://extensions`. If you used Other
Chrome profiles, run `leeway-helper.exe uninstall` to remove the helper and its
file.

## Contact

Questions or issues: please open an issue on the project's repository.

## Changes

Material changes to this policy will update the date at the top.
