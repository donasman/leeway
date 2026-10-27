package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Started by askHello in TestAskHelloStartsTheHelper: the test binary then
// acts as the helper, as Chrome would start it. (TestMain runs before the
// test flags are parsed, so the chrome-extension:// argument is harmless.)
func TestMain(m *testing.M) {
	if os.Getenv("LEEWAY_HELPER_TEST_SERVE") == "1" && launchedByChrome(os.Args[1:]) {
		if err := serve(os.Stdin, os.Stdout, Store{Dir: dataDir(), Now: time.Now}); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// fakeRegistry: "ROOT\path|name" → value.
type fakeRegistry struct {
	strings map[string]string
	dwords  map[string]uint32
}

func (r fakeRegistry) String(root, path, name string) (string, error) {
	if v, ok := r.strings[root+`\`+path+"|"+name]; ok {
		return v, nil
	}
	return "", errNoValue
}

func (r fakeRegistry) DWORD(root, path, name string) (uint32, error) {
	if v, ok := r.dwords[root+`\`+path+"|"+name]; ok {
		return v, nil
	}
	return 0, errNoValue
}

// goodInstall: what install leaves behind, in a temp folder, with a helper
// that answers.
func goodInstall(t *testing.T) (checker, string) {
	t.Helper()
	dir := t.TempDir()
	exe := filepath.Join(dir, "helper", "leeway-helper.exe")
	if err := os.MkdirAll(filepath.Dir(exe), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, []byte("exe"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(dir, "helper", hostName+".json")
	writeManifest(t, manifestPath, manifestFor(exe, defaultExtensionIDs))
	reg := fakeRegistry{strings: map[string]string{`HKCU\` + registrySubkey + "|": manifestPath}, dwords: map[string]uint32{}}
	c := checker{reg: reg, dataDir: dir, installedExe: exe, launch: func(string) (response, error) {
		return response{OK: true, Version: "dev"}, nil
	}}
	return c, manifestPath
}

func writeManifest(t *testing.T, path string, m any) {
	t.Helper()
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// statuses: item name → status, and the failed items' fix lines.
func statuses(items []checkItem) map[string]string {
	out := map[string]string{}
	for _, it := range items {
		out[it.Name] = it.Status
		if it.Status == "FAIL" && it.Fix == "" {
			out[it.Name] = "FAIL without a fix"
		}
	}
	return out
}

// expectOnly: the named items have these statuses ("ANY": not checked), every
// other item is OK.
func expectOnly(t *testing.T, items []checkItem, want map[string]string) {
	t.Helper()
	got := statuses(items)
	if len(items) != 9 {
		t.Fatalf("want 9 items, got %d", len(items))
	}
	for name, status := range got {
		w, named := want[name]
		if !named {
			w = "OK"
		}
		if w != "ANY" && status != w {
			t.Errorf("%s: got %s, want %s", name, status, w)
		}
	}
}

func TestCheckAllOK(t *testing.T) {
	c, _ := goodInstall(t)
	items := c.run()
	expectOnly(t, items, nil)
	var out bytes.Buffer
	if !printChecks(&out, items) {
		t.Fatal("printChecks should report success")
	}
	if !strings.Contains(out.String(), "All checks passed.") || strings.Contains(out.String(), "FAIL") {
		t.Fatalf("output:\n%s", out.String())
	}
}

func TestCheckNotRegistered(t *testing.T) {
	c, _ := goodInstall(t)
	c.reg = fakeRegistry{}
	expectOnly(t, c.run(), map[string]string{
		"Registered with Chrome":                  "FAIL",
		"Host manifest":                           "SKIP",
		"Manifest points at the installed helper": "SKIP",
		"Allows Leeway from the Chrome Web Store": "SKIP",
		"Installed helper starts and answers":     "SKIP",
	})
}

func TestCheckManifestProblems(t *testing.T) {
	dependents := map[string]string{
		"Host manifest": "FAIL",
		"Manifest points at the installed helper": "SKIP",
		"Allows Leeway from the Chrome Web Store": "SKIP",
		"Installed helper starts and answers":     "SKIP",
	}
	cases := map[string]func(t *testing.T, path, exe string){
		"missing":  func(t *testing.T, path, exe string) { os.Remove(path) },
		"not JSON": func(t *testing.T, path, exe string) { os.WriteFile(path, []byte("{nope"), 0o600) },
		"bad name": func(t *testing.T, path, exe string) {
			m := manifestFor(exe, defaultExtensionIDs)
			m.Name = "com.other.host"
			writeManifest(t, path, m)
		},
		"bad type": func(t *testing.T, path, exe string) {
			m := manifestFor(exe, defaultExtensionIDs)
			m.Type = "pipe"
			writeManifest(t, path, m)
		},
	}
	for name, breakIt := range cases {
		t.Run(name, func(t *testing.T) {
			c, path := goodInstall(t)
			breakIt(t, path, c.installedExe)
			expectOnly(t, c.run(), dependents)
		})
	}
}

func TestCheckManifestPath(t *testing.T) {
	t.Run("exe missing", func(t *testing.T) {
		c, _ := goodInstall(t)
		os.Remove(c.installedExe)
		expectOnly(t, c.run(), map[string]string{
			"Manifest points at the installed helper": "FAIL",
			"Installed helper starts and answers":     "SKIP",
		})
	})
	t.Run("another copy", func(t *testing.T) {
		c, path := goodInstall(t)
		other := filepath.Join(t.TempDir(), "leeway-helper.exe")
		os.WriteFile(other, []byte("exe"), 0o700)
		writeManifest(t, path, manifestFor(other, defaultExtensionIDs))
		expectOnly(t, c.run(), map[string]string{
			"Manifest points at the installed helper": "FAIL",
			"Installed helper starts and answers":     "SKIP",
		})
	})
}

func TestCheckStoreOriginMissing(t *testing.T) {
	c, path := goodInstall(t)
	writeManifest(t, path, manifestFor(c.installedExe, []string{"nnknbbnoekgbalackpaekkemnjibicia"}))
	expectOnly(t, c.run(), map[string]string{"Allows Leeway from the Chrome Web Store": "FAIL"})
}

func TestCheckDataFolder(t *testing.T) {
	t.Run("not writable", func(t *testing.T) {
		c, _ := goodInstall(t)
		c.dataDir = filepath.Join(t.TempDir(), "a-file")
		os.WriteFile(c.dataDir, []byte("x"), 0o600) // a file where the folder should be
		// What reading profiles.json under a file says differs by OS (not found
		// on Windows, not a directory elsewhere).
		expectOnly(t, c.run(), map[string]string{"Data folder writable": "FAIL", "Shared file readable": "ANY"})
	})
	t.Run("not created yet: OK when its parent takes a file", func(t *testing.T) {
		c, _ := goodInstall(t)
		c.dataDir = filepath.Join(t.TempDir(), "Leeway")
		items := c.run()
		expectOnly(t, items, nil)
		if _, err := os.Stat(c.dataDir); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("check must not create the data folder")
		}
	})
	t.Run("leaves no file behind", func(t *testing.T) {
		c, _ := goodInstall(t)
		c.run()
		entries, _ := os.ReadDir(c.dataDir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".check-") {
				t.Fatalf("temporary file left: %s", e.Name())
			}
		}
	})
}

func TestCheckSharedFile(t *testing.T) {
	c, _ := goodInstall(t)
	os.WriteFile(filepath.Join(c.dataDir, stateFileName), []byte("{broken"), 0o600)
	expectOnly(t, c.run(), map[string]string{"Shared file readable": "FAIL"})
	os.WriteFile(filepath.Join(c.dataDir, stateFileName), []byte(`{"v":1,"profiles":[]}`), 0o600)
	expectOnly(t, c.run(), nil)
}

func TestCheckPolicies(t *testing.T) {
	t.Run("per-user helpers off", func(t *testing.T) {
		for _, root := range []string{"HKLM", "HKCU"} {
			c, _ := goodInstall(t)
			c.reg.(fakeRegistry).dwords[root+`\`+chromePolicy+"|NativeMessagingUserLevelHosts"] = 0
			expectOnly(t, c.run(), map[string]string{"Chrome policy allows per-user helpers": "FAIL"})
		}
	})
	t.Run("per-user helpers on", func(t *testing.T) {
		c, _ := goodInstall(t)
		c.reg.(fakeRegistry).dwords[`HKLM\`+chromePolicy+"|NativeMessagingUserLevelHosts"] = 1
		expectOnly(t, c.run(), nil)
	})
	block := func(c checker, root string, values ...string) {
		for i, v := range values {
			c.reg.(fakeRegistry).strings[root+`\`+chromePolicy+`\NativeMessagingBlocklist|`+string(rune('1'+i))] = v
		}
	}
	t.Run("blocklist *", func(t *testing.T) {
		c, _ := goodInstall(t)
		block(c, "HKLM", "*")
		expectOnly(t, c.run(), map[string]string{"Chrome policy does not block it": "FAIL"})
	})
	t.Run("blocklist names it", func(t *testing.T) {
		c, _ := goodInstall(t)
		block(c, "HKCU", "com.other.host", hostName)
		expectOnly(t, c.run(), map[string]string{"Chrome policy does not block it": "FAIL"})
	})
	t.Run("blocklist * but allowlisted", func(t *testing.T) {
		c, _ := goodInstall(t)
		block(c, "HKLM", "*")
		c.reg.(fakeRegistry).strings[`HKLM\`+chromePolicy+`\NativeMessagingAllowlist|1`] = hostName
		expectOnly(t, c.run(), nil)
	})
	t.Run("blocklist of other hosts", func(t *testing.T) {
		c, _ := goodInstall(t)
		block(c, "HKLM", "com.other.host")
		expectOnly(t, c.run(), nil)
	})
}

func TestCheckHelperAnswer(t *testing.T) {
	t.Run("does not start", func(t *testing.T) {
		c, _ := goodInstall(t)
		c.launch = func(string) (response, error) { return response{}, errors.New("could not start it: access is denied") }
		expectOnly(t, c.run(), map[string]string{"Installed helper starts and answers": "FAIL"})
	})
	t.Run("answers with an error", func(t *testing.T) {
		c, _ := goodInstall(t)
		c.launch = func(string) (response, error) { return response{OK: false, Error: "shared file is busy"}, nil }
		expectOnly(t, c.run(), map[string]string{"Installed helper starts and answers": "FAIL"})
	})
}

func TestCheckOutputHasFixes(t *testing.T) {
	c, _ := goodInstall(t)
	c.reg = fakeRegistry{}
	var out bytes.Buffer
	if printChecks(&out, c.run()) {
		t.Fatal("printChecks should report failure")
	}
	text := out.String()
	for _, want := range []string{"FAIL  Registered with Chrome", "fix: " + fixInstall, "SKIP  Host manifest: needs: Registered with Chrome", "1 check(s) failed."} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in:\n%s", want, text)
		}
	}
}

// askHello against a real process: this test binary, started as Chrome would
// start the helper (see TestMain).
func TestAskHelloStartsTheHelper(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LEEWAY_HELPER_TEST_SERVE", "1")
	t.Setenv("LEEWAY_HELPER_DIR", t.TempDir())
	reply, err := askHello(exe)
	if err != nil {
		t.Fatal(err)
	}
	if !reply.OK || reply.Version != version {
		t.Fatalf("reply %+v", reply)
	}
	if _, err := askHello(filepath.Join(t.TempDir(), "missing.exe")); err == nil {
		t.Fatal("a missing exe should fail to start")
	}
}
