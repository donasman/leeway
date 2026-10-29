# Leeway helper

A small Windows program that lets Leeway in several Chrome profiles show each
other's usage ("Other Chrome profiles" in the popup). Chrome starts it
through [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
whenever a profile refreshes; it reads and writes one file and exits.

- **What it handles**: the values each profile's popup already shows (remaining
  percent, reset time, plan), the profile's chosen name and a random profile id.
  Never cookies, tokens, email addresses or page text.
- **Where**: `%LOCALAPPDATA%\Leeway\profiles.json`, locked while written and
  replaced in one rename, so two profiles refreshing together can't lose an entry.
- **Limits**: 8 profiles, 16 KB of values per profile, 64 KB per message; an
  entry not refreshed for 7 days is dropped.
- **No network**: the helper makes no network requests.

## Install / uninstall

```
leeway-helper.exe              # install, then check (double-click works)
leeway-helper.exe install [--extension-id <32-letter id>]...
leeway-helper.exe check        # is every step between Chrome and the helper in place?
leeway-helper.exe uninstall
leeway-helper.exe version
```

`install` copies the program to `%LOCALAPPDATA%\Leeway\helper\`, writes
`com.leeway.helper.json` beside it, and registers it for the current Windows user
under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.leeway.helper`, so
every Chrome profile of that user finds it. No administrator rights.

Only the extension IDs in `allowed_origins` may talk to it: the ones in
`defaultExtensionIDs` (`main.go`) plus any `--extension-id`. An unpacked build
loaded without the manifest `key` gets a path-based ID; pass that with
`--extension-id`.

## Check

When the popup says the helper can't be reached, run `leeway-helper.exe check`
(double-clicking the downloaded file installs, then runs the same check). Each
line is `OK` or `FAIL` with how to fix it; `SKIP` means an earlier step failed.
It exits with 1 when anything failed. It only reads, apart from one temporary
file it makes and deletes in the data folder, and uses no network.

| Check | A FAIL means |
|---|---|
| Registered with Chrome | no default value under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.leeway.helper` |
| Host manifest | the file it names is missing or not JSON, or its `name`/`type` is not `com.leeway.helper`/`stdio` |
| Manifest points at the installed helper | its `path` is missing, or is not `%LOCALAPPDATA%\Leeway\helper\leeway-helper.exe` |
| Allows Leeway from the Chrome Web Store | `allowed_origins` lacks `chrome-extension://dlifmhanolkjflblnofiifgkffhkpgga/` |
| Data folder writable | `%LOCALAPPDATA%\Leeway` (before the first run: the folder it goes in) takes no file |
| Shared file readable | `profiles.json` exists but can't be read as JSON |
| Chrome policy allows per-user helpers | `NativeMessagingUserLevelHosts` is 0: only machine-wide helpers |
| Chrome policy does not block it | `NativeMessagingBlocklist` has `*` or `com.leeway.helper` and the allowlist doesn't |
| Installed helper starts and answers | the installed copy, started the way Chrome starts it, didn't answer `hello` (e.g. Smart App Control) |

The first four and the policies are what Chrome itself looks at before it
starts a helper (Chromium `launch_context.cc`, `chrome_messaging_delegate.cc`).

## Build and test

Go 1.22 or later, no dependencies:

```
cd helper
go test ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/leeway-helper.exe .
```

A build from source reports its version as `dev`. The release build sets it from
the tag (`-ldflags "-s -w -X main.version=0.6.3"`). The extension asks the user
to update a helper older than `MIN_HELPER_VERSION` (`extension/peers.js`).

The program is not code-signed, so Windows SmartScreen may warn the first time
it runs, and Windows 11 Smart App Control blocks unsigned programs outright.

## Releases

Pushing a `v*` tag runs `.github/workflows/helper-release.yml`: it tests the
helper, builds `leeway-helper.exe` from this folder and attaches it to that
tag's GitHub Release with `leeway-helper.exe.sha256`. Every release carries the
helper, so the extension's link to
`releases/latest/download/leeway-helper.exe` always resolves.

The extension IDs allowed to talk to the helper are compiled in
(`defaultExtensionIDs` in `main.go`): the Chrome Web Store build
(`dlifmhanolkjflblnofiifgkffhkpgga`) and the development key. Any other ID gets
"access forbidden" until it is added there or passed with `--extension-id`.
