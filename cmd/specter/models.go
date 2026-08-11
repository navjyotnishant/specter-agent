package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"sort"
	"strings"

	"github.com/navjyotnishant/specter-agent/internal/models"
)

// cmdModels lists the models each installed agent CLI supports.
//
// Same discovery the Models page uses, called in-process. The web UI and the
// terminal cannot disagree about what is available, because there is only one
// implementation to disagree with.
func cmdModels(args []string) error {
	fs := flag.NewFlagSet("models", flag.ContinueOnError)
	refresh := fs.Bool("refresh", false, "re-probe instead of using the cached list")
	asJSON := fs.Bool("json", false, "emit a machine-readable result")
	agent := fs.String("agent", "", "only this agent (claude, codex, cursor)")
	if err := fs.Parse(reorderFlagsFirstFor(fs, args)); err != nil {
		return err
	}

	catalogues := models.All(*refresh)
	if *agent != "" {
		catalogues = []models.AgentModels{models.For(*agent, *refresh)}
	}

	if *asJSON {
		out, err := json.MarshalIndent(catalogues, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(out))
		return nil
	}

	fmt.Println()
	for _, c := range catalogues {
		// The reason is printed where the list would be. An agent with no models
		// and no explanation is indistinguishable from a broken probe — which is
		// exactly how the empty Models page read.
		if c.Error != "" {
			fmt.Printf("  %s\n    %s\n\n", bold(c.Agent), dim(c.Error))
			continue
		}

		fmt.Printf("  %s  %s\n", bold(c.Agent), dim(c.Source))
		for _, m := range byFamily(c.Models) {
			fmt.Printf("    %-32s %s", m.Slug, m.DisplayName)
			if len(m.Efforts) > 0 {
				fmt.Printf("  %s", dim("effort: "+strings.Join(m.Efforts, ", ")))
			}
			fmt.Println()
		}
		fmt.Println()
	}
	return nil
}

// byFamily groups models so a long list reads as a few families rather than one
// undifferentiated column. Cursor alone reports nearly two hundred.
func byFamily(in []models.Model) []models.Model {
	out := append([]models.Model(nil), in...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Family != out[j].Family {
			return out[i].Family < out[j].Family
		}
		return out[i].Slug < out[j].Slug
	})
	return out
}
