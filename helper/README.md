# Leeway helper

A small Windows program that lets Leeway in several Chrome profiles show each
other's remaining usage ("Other Chrome profiles" in the popup). Chrome starts it
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
leeway-helper.exe              # same as "install" (double-click works)
leeway-helper.exe install [--extension-id <32-letter id>]...
leeway-helper.exe uninstall
```

`install` copies the program to `%LOCALAPPDATA%\Leeway\helper\`, writes
`com.leeway.helper.json` beside it, and registers it for the current Windows user
under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.leeway.helper`, so
every Chrome profile of that user finds it. No administrator rights.

Only the extension IDs in `allowed_origins` may talk to it: the ones in
`defaultExtensionIDs` (`main.go`) plus any `--extension-id`. An unpacked build
loaded without the manifest `key` gets a path-based ID; pass that with
`--extension-id`.

## Build and test

Go 1.22 or later, no dependencies:

```
cd helper
go test ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/leeway-helper.exe .
```

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
