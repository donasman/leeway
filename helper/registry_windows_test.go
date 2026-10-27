//go:build windows

package main

import (
	"errors"
	"testing"
)

// The real registry, read-only, through values every Windows 10/11 has.
func TestSystemRegistryReads(t *testing.T) {
	const current = `SOFTWARE\Microsoft\Windows NT\CurrentVersion`
	var r systemRegistry
	name, err := r.String("HKLM", current, "ProductName")
	if err != nil || name == "" {
		t.Fatalf("ProductName: %q, %v", name, err)
	}
	if major, err := r.DWORD("HKLM", current, "CurrentMajorVersionNumber"); err != nil || major < 10 {
		t.Fatalf("CurrentMajorVersionNumber: %d, %v", major, err)
	}
	if _, err := r.DWORD("HKLM", current, "ProductName"); err == nil {
		t.Fatal("a text value read as a DWORD")
	}
	if _, err := r.String("HKCU", `Software\Leeway\no such key`, ""); !errors.Is(err, errNoValue) {
		t.Fatalf("missing key: %v", err)
	}
	if _, err := r.String("HKLM", current, "no such value"); !errors.Is(err, errNoValue) {
		t.Fatalf("missing value: %v", err)
	}
}
