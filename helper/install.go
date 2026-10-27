package main

// Registration for the current Windows user (no administrator rights): the
// helper copies itself to %LOCALAPPDATA%\Leeway\helper, writes the Native
// Messaging manifest beside it, and points Chrome's per-user registry key at
// that manifest. Every Chrome profile of this Windows user then finds it.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

var extensionIDPattern = regexp.MustCompile(`^[a-p]{32}$`)

const (
	registrySubkey = `Software\Google\Chrome\NativeMessagingHosts\` + hostName
	registryKey    = `HKCU\` + registrySubkey
)

type hostManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

func manifestFor(exePath string, ids []string) hostManifest {
	origins := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		if extensionIDPattern.MatchString(id) && !seen[id] {
			seen[id] = true
			origins = append(origins, "chrome-extension://"+id+"/")
		}
	}
	return hostManifest{
		Name:           hostName,
		Description:    "Leeway helper: shares remaining-usage values between your Chrome profiles",
		Path:           exePath,
		Type:           "stdio",
		AllowedOrigins: origins,
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func install(ids []string) error {
	if runtime.GOOS != "windows" {
		return errors.New("install is for Windows; on other systems register the manifest by hand")
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	dir := filepath.Join(dataDir(), "helper")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	target := filepath.Join(dir, "leeway-helper.exe")
	if !strings.EqualFold(filepath.Clean(self), filepath.Clean(target)) {
		if err := copyFile(self, target); err != nil {
			return fmt.Errorf("could not copy the helper to %s: %w", target, err)
		}
	}
	manifest := manifestFor(target, ids)
	if len(manifest.AllowedOrigins) == 0 {
		return errors.New("no extension ID to allow")
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	manifestPath := filepath.Join(dir, hostName+".json")
	if err := os.WriteFile(manifestPath, data, 0o600); err != nil {
		return err
	}
	if out, err := exec.Command("reg", "add", registryKey, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f").CombinedOutput(); err != nil {
		return fmt.Errorf("registry: %v: %s", err, strings.TrimSpace(string(out)))
	}
	fmt.Println("Leeway helper is registered for this Windows user.")
	fmt.Println("  helper:   " + target)
	fmt.Println("  manifest: " + manifestPath)
	fmt.Println("  allowed:  " + strings.Join(manifest.AllowedOrigins, ", "))
	fmt.Println("Turn on \"Other Chrome profiles\" in Leeway's popup in each profile.")
	return nil
}

func uninstall() error {
	if runtime.GOOS != "windows" {
		return errors.New("uninstall is for Windows")
	}
	out, err := exec.Command("reg", "delete", registryKey, "/f").CombinedOutput()
	if err != nil && !strings.Contains(strings.ToLower(string(out)), "unable to find") {
		fmt.Fprintln(os.Stderr, "registry:", strings.TrimSpace(string(out)))
	}
	// The copy running this command (if any) can't delete itself; the rest goes.
	dir := dataDir()
	if err := os.RemoveAll(dir); err != nil {
		fmt.Println("Removed the registration. Some files are still in use; delete this folder later:", dir)
		return nil
	}
	fmt.Println("Leeway helper removed (registry entry and " + dir + ").")
	return nil
}
