//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"syscall"
	"unicode/utf16"
)

// systemRegistry reads with the standard library's syscall wrappers (no
// dependencies, CLAUDE.md §2). Read-only: KEY_READ.
type systemRegistry struct{}

func rootKey(root string) (syscall.Handle, error) {
	switch root {
	case "HKCU":
		return syscall.HKEY_CURRENT_USER, nil
	case "HKLM":
		return syscall.HKEY_LOCAL_MACHINE, nil
	}
	return 0, fmt.Errorf("unknown registry root %q", root)
}

func (systemRegistry) value(root, path, name string) (uint32, []byte, error) {
	base, err := rootKey(root)
	if err != nil {
		return 0, nil, err
	}
	subkey, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, nil, err
	}
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(base, subkey, 0, syscall.KEY_READ, &key); err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return 0, nil, errNoValue
		}
		return 0, nil, err
	}
	defer syscall.RegCloseKey(key)
	valueName, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, nil, err
	}
	var kind, size uint32
	if err := syscall.RegQueryValueEx(key, valueName, nil, &kind, nil, &size); err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return 0, nil, errNoValue
		}
		return 0, nil, err
	}
	if size == 0 {
		return kind, nil, nil
	}
	buf := make([]byte, size)
	if err := syscall.RegQueryValueEx(key, valueName, nil, &kind, &buf[0], &size); err != nil {
		return 0, nil, err
	}
	return kind, buf[:size], nil
}

func (r systemRegistry) String(root, path, name string) (string, error) {
	kind, buf, err := r.value(root, path, name)
	if err != nil {
		return "", err
	}
	if kind != syscall.REG_SZ && kind != syscall.REG_EXPAND_SZ {
		return "", fmt.Errorf("not a text value (type %d)", kind)
	}
	units := make([]uint16, len(buf)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(buf[2*i:])
	}
	for len(units) > 0 && units[len(units)-1] == 0 {
		units = units[:len(units)-1]
	}
	return string(utf16.Decode(units)), nil
}

func (r systemRegistry) DWORD(root, path, name string) (uint32, error) {
	kind, buf, err := r.value(root, path, name)
	if err != nil {
		return 0, err
	}
	if kind != syscall.REG_DWORD || len(buf) != 4 {
		return 0, fmt.Errorf("not a DWORD value (type %d)", kind)
	}
	return binary.LittleEndian.Uint32(buf), nil
}
