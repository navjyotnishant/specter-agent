//go:build !linux

package api

import "runtime"

// Python's health endpoint reads /proc/meminfo and os.getloadavg(), and reports
// "unavailable" wherever they are absent — which is every non-Linux platform.
// Reporting unavailable is the honest answer; inventing a number for a metric
// that cannot be sampled is worse than admitting the gap.
//
// The container runs Linux, so the deployed backend gets real numbers. This
// path exists so the binary builds and the CLI runs on a developer's Mac.
func loadStatus() map[string]any {
	return unavailableLoad(runtime.NumCPU(), "Load average is unavailable on this platform.")
}

func memoryStatus() map[string]any {
	return unavailableMemory()
}
