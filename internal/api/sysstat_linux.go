//go:build linux

package api

import (
	"os"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// Linux exposes load and memory through sysinfo(2). Python reads
// os.getloadavg() and /proc/meminfo for the same numbers.
func loadStatus() map[string]any {
	var info unix.Sysinfo_t
	cpuCount := runtime.NumCPU()
	if err := unix.Sysinfo(&info); err != nil {
		return unavailableLoad(cpuCount, "Load average is unavailable on this platform.")
	}
	// Linux scales load averages by 2^16.
	const scale = 65536.0
	load1 := float64(info.Loads[0]) / scale
	load5 := float64(info.Loads[1]) / scale
	load15 := float64(info.Loads[2]) / scale
	pressure := load1 / float64(cpuCount) * 100

	status := "healthy"
	switch {
	case pressure >= 120:
		status = "critical"
	case pressure >= 80:
		status = "warning"
	}
	return map[string]any{
		"status": status,
		"load_1": roundTo2(load1), "load_5": roundTo2(load5), "load_15": roundTo2(load15),
		"cpu_count":        cpuCount,
		"pressure_percent": roundTo1(pressure),
		"message":          "Load average sampled.",
	}
}

// memoryStatus reads /proc/meminfo, the same source Python uses.
//
// NOT sysinfo(2). Its Freeram + Bufferram misses reclaimable page cache, which
// on this container read 98.8% used against Python's 93.3% for the same moment.
// MemAvailable is the kernel's own estimate of what a new allocation can
// actually get, and reproducing it by hand is guesswork — so read the value the
// kernel publishes.
func memoryStatus() map[string]any {
	meminfo, err := readMeminfo()
	if err != nil {
		return unavailableMemory()
	}
	total, hasTotal := meminfo["MemTotal"]
	available, hasAvailable := meminfo["MemAvailable"]
	if !hasTotal || !hasAvailable || total == 0 {
		return unavailableMemory()
	}

	used := total - available
	usedPercent := roundTo1(float64(used) / float64(total) * 100)

	status := "healthy"
	switch {
	case usedPercent >= 92:
		status = "critical"
	case usedPercent >= 80:
		status = "warning"
	}
	return map[string]any{
		"status": status, "total_bytes": total, "used_bytes": used,
		"available_bytes": available, "used_percent": usedPercent,
		"message": "Memory sampled.",
	}
}

// readMeminfo parses /proc/meminfo into bytes. Values there are in kB.
func readMeminfo() (map[string]uint64, error) {
	body, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return nil, err
	}
	values := map[string]uint64{}
	for _, line := range strings.Split(string(body), "\n") {
		key, rest, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		values[key] = n * 1024
	}
	return values, nil
}
