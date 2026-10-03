// Command attrition scans a source tree for OpenTelemetry attribute keys,
// metric names, event names and enum values that the semantic conventions have
// deprecated, renamed or dropped.
//
// It walks the given paths, keeps only files that mention an attribute-like
// string or a semconv constant, and sends each one to the Attrition
// scan API. That API reads every verdict from the Sanity dataset through
// Sanity Context, so the CLI and the web app always agree.
//
//	attrition ./services            # report
//	attrition -json ./services      # machine-readable report
//	attrition -fail ./services      # exit 1 when anything is deprecated (CI)
//	attrition -fix ./services       # apply the unambiguous string renames
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"text/tabwriter"
	"time"
)

const defaultAPI = "https://attrition-otel.vercel.app/api/scan"

var sourceExt = map[string]bool{
	".go": true, ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
	".py": true, ".java": true, ".kt": true, ".scala": true, ".cs": true, ".rb": true, ".php": true,
	".rs": true, ".swift": true, ".ex": true, ".exs": true, ".cpp": true, ".cc": true, ".h": true,
	".yaml": true, ".yml": true,
}

var skipDir = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true, "build": true, ".next": true,
	"target": true, "__pycache__": true, ".venv": true, "venv": true, "third_party": true,
}

// A cheap filter so only files that could contain a semconv name are sent:
// any dotted lowercase string literal, or an SDK constant.
var candidate = regexp.MustCompile(`["'` + "`" + `][a-z][a-z0-9_]*\.[a-z0-9_.]+["'` + "`" + `]|semconv\.|SEMATTRS_|SEMRESATTRS_|ATTR_[A-Z]|Attributes\.[A-Z_]+`)

type edit struct {
	Line int    `json:"line"`
	From string `json:"from"`
	To   string `json:"to"`
}

type finding struct {
	Key               string   `json:"key"`
	Kind              string   `json:"kind"`
	Value             string   `json:"value,omitempty"`
	Status            string   `json:"status"`
	Verdict           string   `json:"verdict"`
	Lines             []int    `json:"lines"`
	Forms             []string `json:"forms"`
	Replacement       string   `json:"replacement"`
	ReplacementReason string   `json:"replacementReason"`
	NeedsDecision     bool     `json:"needsDecision"`
	DeprecatedIn      string   `json:"deprecatedIn"`
	SpanKind          string   `json:"spanKind"`
	SourceURL         string   `json:"sourceUrl"`
}

type scanResult struct {
	Language    string    `json:"language"`
	SpecRelease string    `json:"specRelease"`
	Findings    []finding `json:"findings"`
	Edits       []edit    `json:"edits"`
	Error       string    `json:"error"`
}

type fileReport struct {
	Path     string    `json:"path"`
	Findings []finding `json:"findings"`
	Edits    []edit    `json:"edits,omitempty"`
	Error    string    `json:"error,omitempty"`
}

type report struct {
	SpecRelease  string         `json:"specRelease"`
	FilesWalked  int            `json:"filesWalked"`
	FilesScanned int            `json:"filesScanned"`
	Deprecated   int            `json:"deprecatedUsages"`
	InComments   int            `json:"deprecatedInComments"`
	ByVerdict    map[string]int `json:"byVerdict"`
	ByKey        map[string]int `json:"byKey"`
	Files        []fileReport   `json:"files"`
}

func main() {
	api := flag.String("api", envOr("ATTRITION_API", defaultAPI), "scan API endpoint")
	asJSON := flag.Bool("json", false, "print the report as JSON")
	fail := flag.Bool("fail", false, "exit with status 1 if any deprecated attribute is found")
	fix := flag.Bool("fix", false, "rewrite string keys that have exactly one unconditional replacement")
	workers := flag.Int("workers", 4, "concurrent requests")
	maxBytes := flag.Int64("max-bytes", 80_000, "skip files larger than this")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: attrition [flags] [path ...]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	roots := flag.Args()
	if len(roots) == 0 {
		roots = []string{"."}
	}

	files, walked, err := collect(roots, *maxBytes)
	if err != nil {
		fmt.Fprintln(os.Stderr, "attrition:", err)
		os.Exit(2)
	}

	rep := run(*api, files, *workers)
	rep.FilesWalked = walked

	if *fix {
		applied, err := applyEdits(rep.Files)
		if err != nil {
			fmt.Fprintln(os.Stderr, "attrition: fix:", err)
			os.Exit(2)
		}
		fmt.Fprintf(os.Stderr, "attrition: rewrote %d lines\n", applied)
	}

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(rep)
	} else {
		printText(os.Stdout, rep)
	}
	if *fail && rep.Deprecated > 0 {
		os.Exit(1)
	}
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func collect(roots []string, maxBytes int64) ([]string, int, error) {
	var out []string
	walked := 0
	for _, root := range roots {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if path != root && (skipDir[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
					return filepath.SkipDir
				}
				return nil
			}
			if !sourceExt[strings.ToLower(filepath.Ext(path))] || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			walked++
			info, err := d.Info()
			if err != nil || info.Size() > maxBytes {
				return nil
			}
			b, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			if candidate.Match(b) {
				out = append(out, path)
			}
			return nil
		})
		if err != nil {
			return nil, walked, err
		}
	}
	sort.Strings(out)
	return out, walked, nil
}

func run(api string, files []string, workers int) report {
	rep := report{ByVerdict: map[string]int{}, ByKey: map[string]int{}}
	results := make([]fileReport, len(files))
	client := &http.Client{Timeout: 60 * time.Second}

	var wg sync.WaitGroup
	sem := make(chan struct{}, max(1, workers))
	var mu sync.Mutex
	for i, path := range files {
		wg.Add(1)
		go func(i int, path string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			res, err := scanFile(client, api, path)
			fr := fileReport{Path: path}
			if err != nil {
				fr.Error = err.Error()
			} else {
				for _, f := range res.Findings {
					if f.Status != "current" {
						fr.Findings = append(fr.Findings, f)
					}
				}
				fr.Edits = res.Edits
				mu.Lock()
				if rep.SpecRelease == "" {
					rep.SpecRelease = res.SpecRelease
				}
				mu.Unlock()
			}
			results[i] = fr
		}(i, path)
	}
	wg.Wait()

	rep.FilesScanned = len(files)
	for _, fr := range results {
		for _, f := range fr.Findings {
			if len(f.Forms) == 1 && f.Forms[0] == "comment" {
				rep.InComments += len(f.Lines)
				continue
			}
			rep.Deprecated += len(f.Lines)
			rep.ByVerdict[f.Verdict] += len(f.Lines)
			rep.ByKey[f.Kind+":"+f.Key] += len(f.Lines)
		}
		if len(fr.Findings) > 0 || fr.Error != "" {
			rep.Files = append(rep.Files, fr)
		}
	}
	return rep
}

func scanFile(client *http.Client, api, path string) (*scanResult, error) {
	code, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]string{"code": string(code)})
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
		}
		resp, err := client.Post(api, "application/json", bytes.NewReader(body))
		if err != nil {
			lastErr = err
			continue
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var res scanResult
		if err := json.Unmarshal(raw, &res); err != nil {
			lastErr = fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
			continue
		}
		if resp.StatusCode >= 500 {
			lastErr = errors.New(res.Error)
			continue
		}
		if res.Error != "" {
			return nil, errors.New(res.Error)
		}
		return &res, nil
	}
	return nil, lastErr
}

func applyEdits(files []fileReport) (int, error) {
	applied := 0
	for _, fr := range files {
		if len(fr.Edits) == 0 {
			continue
		}
		b, err := os.ReadFile(fr.Path)
		if err != nil {
			return applied, err
		}
		lines := strings.Split(string(b), "\n")
		for _, e := range fr.Edits {
			i := e.Line - 1
			if i >= 0 && i < len(lines) && strings.Contains(lines[i], e.From) {
				lines[i] = strings.ReplaceAll(lines[i], e.From, e.To)
				applied++
			}
		}
		if err := os.WriteFile(fr.Path, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
			return applied, err
		}
	}
	return applied, nil
}

func printText(w io.Writer, rep report) {
	fmt.Fprintf(w, "Attrition, spec %s\n", rep.SpecRelease)
	fmt.Fprintf(w, "%d source files walked, %d mention attributes, %d deprecated usages in code, %d in comments\n\n", rep.FilesWalked, rep.FilesScanned, rep.Deprecated, rep.InComments)
	tw := tabwriter.NewWriter(w, 0, 2, 2, ' ', 0)
	for _, fr := range rep.Files {
		if fr.Error != "" {
			fmt.Fprintf(tw, "%s\terror\t%s\n", fr.Path, fr.Error)
			continue
		}
		for _, f := range fr.Findings {
			to := f.Replacement
			if to == "" {
				to = "(" + f.ReplacementReason + ")"
			}
			if f.Replacement != "" && f.NeedsDecision {
				to = f.Replacement + "  (check first: not a plain rename)"
			}
			name := f.Key
			if f.Value != "" {
				name = fmt.Sprintf("%s = %q", f.Key, f.Value)
				if f.Replacement != "" {
					to = fmt.Sprintf("%q", f.Replacement)
				}
			}
			fmt.Fprintf(tw, "%s:%s\t%s\t%s\t%s\t-> %s\n", fr.Path, joinInts(f.Lines), f.Kind, f.Verdict, name, to)
		}
	}
	tw.Flush()
	if len(rep.ByVerdict) > 0 {
		fmt.Fprintln(w)
		keys := make([]string, 0, len(rep.ByVerdict))
		for k := range rep.ByVerdict {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(w, "  %-22s %d\n", k, rep.ByVerdict[k])
		}
	}
}

func joinInts(xs []int) string {
	s := make([]string, len(xs))
	for i, x := range xs {
		s[i] = fmt.Sprint(x)
	}
	return strings.Join(s, ",")
}
