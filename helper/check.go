package main

// "leeway-helper.exe check": looks at each step between Chrome and the helper
// and prints OK or FAIL with one line on how to fix it. Read-only, apart from
// one temporary file in the data folder; no network.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	storeOrigin  = "chrome-extension://dlifmhanolkjflblnofiifgkffhkpgga/"
	chromePolicy = `Software\Policies\Google\Chrome`
)

type checkItem struct {
	Name   string
	Status string // "OK", "FAIL" or "SKIP" (an earlier step failed)
	Detail string
	Fix    string
}

type checker struct {
	reg          registry
	dataDir      string // %LOCALAPPDATA%\Leeway
	installedExe string // where install copies the helper
	launch       func(exe string) (response, error)
}

func newChecker() checker {
	dir := dataDir()
	return checker{reg: systemRegistry{}, dataDir: dir, installedExe: filepath.Join(dir, "helper", "leeway-helper.exe"), launch: askHello}
}

func itemOK(name, detail string) checkItem {
	return checkItem{Name: name, Status: "OK", Detail: detail}
}
func itemFail(name, detail, fix string) checkItem {
	return checkItem{Name: name, Status: "FAIL", Detail: detail, Fix: fix}
}
func itemSkip(name, after string) checkItem {
	return checkItem{Name: name, Status: "SKIP", Detail: "needs: " + after}
}

const fixInstall = "Run leeway-helper.exe again (double-click, or: leeway-helper.exe install)."

func (c checker) run() []checkItem {
	var items []checkItem

	// 1. Chrome finds the host through this per-user registry key.
	const regName = "Registered with Chrome"
	manifestPath, err := c.reg.String("HKCU", registrySubkey, "")
	registered := err == nil && manifestPath != ""
	switch {
	case registered:
		items = append(items, itemOK(regName, `HKCU\`+registrySubkey+" -> "+manifestPath))
	case errors.Is(err, errNoValue) || err == nil:
		items = append(items, itemFail(regName, `HKCU\`+registrySubkey+" has no default value", fixInstall))
	default:
		items = append(items, itemFail(regName, err.Error(), fixInstall))
	}

	// 2. The manifest it points at.
	const manName = "Host manifest"
	var manifest hostManifest
	manifestOK := false
	if !registered {
		items = append(items, itemSkip(manName, regName))
	} else if data, err := os.ReadFile(manifestPath); err != nil {
		items = append(items, itemFail(manName, "can't read "+manifestPath+": "+errText(err), fixInstall))
	} else if err := json.Unmarshal(data, &manifest); err != nil {
		items = append(items, itemFail(manName, manifestPath+" is not valid JSON", fixInstall))
	} else if manifest.Name != hostName {
		items = append(items, itemFail(manName, fmt.Sprintf("name is %q, not %q", manifest.Name, hostName), fixInstall))
	} else if manifest.Type != "stdio" {
		items = append(items, itemFail(manName, fmt.Sprintf("type is %q, not \"stdio\"", manifest.Type), fixInstall))
	} else {
		manifestOK = true
		items = append(items, itemOK(manName, manifestPath))
	}

	// 3. Its path: the copy install made.
	const pathName = "Manifest points at the installed helper"
	exeOK := false
	if !manifestOK {
		items = append(items, itemSkip(pathName, manName))
	} else if _, err := os.Stat(manifest.Path); err != nil {
		items = append(items, itemFail(pathName, manifest.Path+" does not exist", fixInstall))
	} else if !strings.EqualFold(filepath.Clean(manifest.Path), filepath.Clean(c.installedExe)) {
		items = append(items, itemFail(pathName, manifest.Path+" is not "+c.installedExe, fixInstall))
	} else {
		exeOK = true
		items = append(items, itemOK(pathName, manifest.Path))
	}

	// 4. The Web Store Leeway may talk to it.
	const originName = "Allows Leeway from the Chrome Web Store"
	if !manifestOK {
		items = append(items, itemSkip(originName, manName))
	} else if !contains(manifest.AllowedOrigins, storeOrigin) {
		items = append(items, itemFail(originName, "allowed_origins: "+strings.Join(manifest.AllowedOrigins, ", "), fixInstall))
	} else {
		items = append(items, itemOK(originName, strings.Join(manifest.AllowedOrigins, ", ")))
	}

	// 5. The data folder takes a file. Before the first run it may not exist
	// yet (the helper makes it); then the folder it would be made in must.
	const dirName = "Data folder writable"
	where, note := c.dataDir, ""
	if _, err := os.Stat(c.dataDir); errors.Is(err, os.ErrNotExist) {
		where, note = filepath.Dir(c.dataDir), " (not created yet; the helper makes it there)"
	}
	if f, err := os.CreateTemp(where, ".check-*"); err != nil {
		items = append(items, itemFail(dirName, where+": "+errText(err), "Make sure your Windows user may write to this folder (security software can block it), then run leeway-helper.exe again."))
	} else {
		name := f.Name()
		f.Close()
		os.Remove(name)
		items = append(items, itemOK(dirName, c.dataDir+note))
	}

	// 6. The shared file, if there is one yet.
	const fileName = "Shared file readable"
	statePath := filepath.Join(c.dataDir, stateFileName)
	if data, err := os.ReadFile(statePath); errors.Is(err, os.ErrNotExist) {
		items = append(items, itemOK(fileName, "not created yet (each profile writes it on its next refresh)"))
	} else if err != nil {
		items = append(items, itemFail(fileName, statePath+": "+errText(err), "Close anything that keeps "+statePath+" open, or delete it; Leeway writes it again."))
	} else if st := (State{}); json.Unmarshal(data, &st) != nil {
		items = append(items, itemFail(fileName, statePath+" is not valid JSON", "Delete "+statePath+"; each profile writes it again on its next refresh."))
	} else {
		items = append(items, itemOK(fileName, fmt.Sprintf("%s (%d profiles)", statePath, len(st.Profiles))))
	}

	// 7. A policy can keep Chrome to machine-wide hosts; this one is per user.
	const userLevelName = "Chrome policy allows per-user helpers"
	if root, off := c.userLevelHostsOff(); off {
		items = append(items, itemFail(userLevelName, root+`\`+chromePolicy+` NativeMessagingUserLevelHosts = 0`, "Your administrator allows only machine-wide helpers. Ask them; reinstalling won't help."))
	} else {
		items = append(items, itemOK(userLevelName, "NativeMessagingUserLevelHosts not set to 0"))
	}

	// 8. Or block helpers by name (Chromium: blocklist with "*" or the name,
	// unless the allowlist names it).
	const blockName = "Chrome policy does not block it"
	block := c.policyList("NativeMessagingBlocklist")
	if (contains(block, hostName) || contains(block, "*")) && !contains(c.policyList("NativeMessagingAllowlist"), hostName) {
		items = append(items, itemFail(blockName, "NativeMessagingBlocklist: "+strings.Join(block, ", "), "Your administrator blocks helper programs. Ask them to allow "+hostName+"; reinstalling won't help."))
	} else {
		items = append(items, itemOK(blockName, "not blocked"))
	}

	// 9. The installed copy starts and answers, as it would for Chrome.
	const answerName = "Installed helper starts and answers"
	if !exeOK {
		items = append(items, itemSkip(answerName, pathName))
	} else if reply, err := c.launch(c.installedExe); err != nil {
		items = append(items, itemFail(answerName, errText(err), "Windows may have blocked it (SmartScreen, Smart App Control or security software): allow leeway-helper.exe, then run it again."))
	} else if !reply.OK {
		items = append(items, itemFail(answerName, "answered with an error: "+reply.Error, "Run leeway-helper.exe again; if this stays, report it with this output."))
	} else {
		items = append(items, itemOK(answerName, "version "+reply.Version))
	}
	return items
}

// userLevelHostsOff: NativeMessagingUserLevelHosts = 0 under either policy root.
func (c checker) userLevelHostsOff() (string, bool) {
	for _, root := range []string{"HKLM", "HKCU"} {
		if v, err := c.reg.DWORD(root, chromePolicy, "NativeMessagingUserLevelHosts"); err == nil && v == 0 {
			return root, true
		}
	}
	return "", false
}

// policyList: a Chrome list policy as Windows stores it, a key whose values
// are named "1", "2", ... (machine and user lists together).
func (c checker) policyList(policy string) []string {
	var out []string
	for _, root := range []string{"HKLM", "HKCU"} {
		for i := 1; i <= 1000; i++ {
			v, err := c.reg.String(root, chromePolicy+`\`+policy, strconv.Itoa(i))
			if err != nil {
				break
			}
			out = append(out, v)
		}
	}
	return out
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// errText: the error without the operation and path os adds (the path is
// printed beside it already).
func errText(err error) string {
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err.Error()
	}
	return err.Error()
}

// printChecks writes one line per item (and its fix under a FAIL) and
// reports whether every item passed.
func printChecks(w io.Writer, items []checkItem) bool {
	failed := 0
	fmt.Fprintf(w, "Leeway helper %s - checking the connection to Chrome\n", version)
	for _, it := range items {
		fmt.Fprintf(w, "  %-4s  %s: %s\n", it.Status, it.Name, it.Detail)
		if it.Status == "FAIL" {
			failed++
			fmt.Fprintf(w, "        fix: %s\n", it.Fix)
		}
	}
	if failed == 0 {
		fmt.Fprintln(w, "All checks passed.")
		return true
	}
	fmt.Fprintf(w, "%d check(s) failed.\n", failed)
	return false
}

// askHello starts exe the way Chrome does (the caller origin as its argument)
// and asks it "hello" over stdin/stdout. Local pipes only.
func askHello(exe string) (response, error) {
	cmd := exec.Command(exe, storeOrigin)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return response{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return response{}, err
	}
	if err := cmd.Start(); err != nil {
		return response{}, fmt.Errorf("could not start it: %w", err)
	}
	type result struct {
		reply response
		err   error
	}
	done := make(chan result, 1)
	go func() {
		if err := writeMessage(stdin, map[string]string{"type": "hello"}); err != nil {
			done <- result{err: err}
			return
		}
		stdin.Close()
		body, err := readMessage(stdout)
		if err != nil {
			done <- result{err: fmt.Errorf("no answer: %w", err)}
			return
		}
		var reply response
		if err := json.Unmarshal(body, &reply); err != nil {
			done <- result{err: errors.New("the answer is not JSON")}
			return
		}
		done <- result{reply: reply}
	}()
	select {
	case r := <-done:
		cmd.Wait()
		return r.reply, r.err
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		cmd.Wait()
		return response{}, errors.New("no answer within 10 seconds")
	}
}
