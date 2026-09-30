//! attrition-offline: the Attrition scanner with no network at scan time.
//!
//! `snapshot` downloads the public Sanity dataset once (no token needed) and
//! stores it in `.attrition/snapshot.json`. `scan` then checks files against
//! that snapshot locally, which suits pre-commit hooks and air-gapped CI.
//!
//!   attrition-offline snapshot
//!   attrition-offline scan src/            # report
//!   attrition-offline scan --fail $(git diff --cached --name-only)

mod extract;

use extract::{Form, Index, extract};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;
use walkdir::WalkDir;

const PROJECT: &str = "y9raau23";
const DATASET: &str = "production";
const SNAPSHOT: &str = ".attrition/snapshot.json";

const QUERY: &str = r#"{
  "release": *[_type == "specRelease"][0].tag,
  "attributes": *[_type == "attribute"]{
    key, status, "members": members[].value, "src": source.url,
    "verdict": deprecation.verdict, "deprecatedIn": deprecation.deprecatedIn, "valueChanges": deprecation.valueChanges,
    "replacements": deprecation.replacements[]{key, when}
  }
}"#;

#[derive(Serialize, Deserialize)]
struct Snapshot {
    release: String,
    attributes: Vec<Attribute>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Attribute {
    key: String,
    status: String,
    #[serde(default)]
    members: Option<Vec<String>>,
    src: Option<String>,
    verdict: Option<String>,
    #[serde(rename = "deprecatedIn")]
    deprecated_in: Option<String>,
    #[serde(default)]
    replacements: Option<Vec<Replacement>>,
    #[serde(rename = "valueChanges", default)]
    value_changes: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Replacement {
    key: String,
    when: Option<String>,
}

const EXTENSIONS: &[&str] = &[
    "go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "kt", "scala", "cs", "rb", "php", "rs", "swift", "ex",
    "exs", "cpp", "cc", "h", "yaml", "yml",
];
const SKIP: &[&str] = &[".git", "node_modules", "vendor", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv"];

fn snapshot() -> Result<(), String> {
    let url = format!(
        "https://{PROJECT}.apicdn.sanity.io/v2025-02-19/data/query/{DATASET}?query={}",
        urlencode(QUERY)
    );
    let body = ureq::get(&url).call().map_err(|e| e.to_string())?.body_mut().read_to_string().map_err(|e| e.to_string())?;
    #[derive(Deserialize)]
    struct Resp {
        result: Snapshot,
    }
    let resp: Resp = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(".attrition").map_err(|e| e.to_string())?;
    std::fs::write(SNAPSHOT, serde_json::to_string(&resp.result).unwrap()).map_err(|e| e.to_string())?;
    let deprecated = resp.result.attributes.iter().filter(|a| a.status == "deprecated").count();
    println!("saved {SNAPSHOT}: spec {}, {} attributes, {deprecated} deprecated", resp.result.release, resp.result.attributes.len());
    Ok(())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn choose(a: &Attribute, span_kind: Option<&str>) -> String {
    let reps = a.replacements.clone().unwrap_or_default();
    match a.verdict.as_deref() {
        Some("RENAMED" | "REPLACED") => {
            let key = reps.first().map(|r| r.key.clone()).unwrap_or_default();
            if a.value_changes == Some(true) { format!("{key} (value format changes too)") } else { key }
        }
        Some("SPAN_KIND_DEPENDENT") => match span_kind {
            Some(k) => reps
                .iter()
                .find(|r| r.when.as_deref().is_some_and(|w| w.starts_with(k)))
                .map(|r| r.key.clone())
                .unwrap_or_else(|| "(no replacement for this span kind)".into()),
            None => format!(
                "({})",
                reps.iter().map(|r| format!("{} on {}", r.key, r.when.clone().unwrap_or_default())).collect::<Vec<_>>().join(", ")
            ),
        },
        Some("REMOVED") => "(delete it)".into(),
        Some("MOVED_OUT") => "(moved to another repository)".into(),
        Some("MERGED_INTO") => format!("(fold into {})", reps.first().map(|r| r.key.as_str()).unwrap_or("?")),
        Some("SPLIT") => format!("({})", reps.iter().map(|r| r.key.as_str()).collect::<Vec<_>>().join(" + ")),
        _ => "(see the spec note)".into(),
    }
}

fn files(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in paths {
        for e in WalkDir::new(p).into_iter().filter_entry(|e| {
            e.depth() == 0 || !(e.file_type().is_dir() && (SKIP.contains(&e.file_name().to_string_lossy().as_ref()) || e.file_name().to_string_lossy().starts_with('.')))
        }) {
            let Ok(e) = e else { continue };
            let path = e.path();
            let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("");
            if e.file_type().is_file() && EXTENSIONS.contains(&ext) && !path.to_string_lossy().ends_with("_test.go") {
                out.push(path.to_path_buf());
            }
        }
    }
    out.sort();
    out
}

fn scan(paths: Vec<PathBuf>, fail: bool, json: bool) -> Result<ExitCode, String> {
    let raw = std::fs::read_to_string(SNAPSHOT).map_err(|_| format!("no {SNAPSHOT}; run `attrition-offline snapshot` first"))?;
    let snap: Snapshot = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let by_key: BTreeMap<String, Attribute> = snap.attributes.iter().map(|a| (a.key.clone(), a.clone())).collect();
    let index = Index::new(snap.attributes.iter().map(|a| (a.key.clone(), a.members.clone().unwrap_or_default())));

    let started = Instant::now();
    let targets = files(&if paths.is_empty() { vec![PathBuf::from(".")] } else { paths });
    let (mut in_code, mut in_comments) = (0usize, 0usize);
    let mut by_verdict: BTreeMap<String, usize> = BTreeMap::new();
    let mut rows = Vec::new();

    for path in &targets {
        let Ok(code) = std::fs::read_to_string(path) else { continue };
        if code.len() > 80_000 {
            continue;
        }
        for u in extract(&code, &index) {
            let Some(a) = by_key.get(&u.key) else { continue };
            if a.status != "deprecated" {
                continue;
            }
            let verdict = a.verdict.clone().unwrap_or_default();
            if u.form == Form::Comment {
                in_comments += 1;
            } else {
                in_code += 1;
                *by_verdict.entry(verdict.clone()).or_default() += 1;
            }
            rows.push(serde_json::json!({
                "path": display(path), "line": u.line, "key": u.key, "verdict": verdict,
                "use": choose(a, u.span_kind.as_deref()), "spanKind": u.span_kind,
                "comment": u.form == Form::Comment, "deprecatedIn": a.deprecated_in, "src": a.src,
            }));
        }
    }
    let elapsed = started.elapsed();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "specRelease": snap.release, "files": targets.len(), "deprecatedInCode": in_code,
                "deprecatedInComments": in_comments, "byVerdict": by_verdict, "findings": rows,
                "millis": elapsed.as_millis(),
            }))
            .unwrap()
        );
    } else {
        println!("Attrition (offline), spec {}", snap.release);
        println!(
            "{} files in {:.0} ms, {in_code} deprecated usages in code, {in_comments} in comments\n",
            targets.len(),
            elapsed.as_secs_f64() * 1000.0
        );
        for r in &rows {
            println!(
                "{}:{}  {:<20} {:<40} -> {}{}",
                r["path"].as_str().unwrap(),
                r["line"],
                r["verdict"].as_str().unwrap(),
                r["key"].as_str().unwrap(),
                r["use"].as_str().unwrap(),
                if r["comment"].as_bool().unwrap() { "  (comment)" } else { "" }
            );
        }
        if !by_verdict.is_empty() {
            println!();
            for (v, n) in &by_verdict {
                println!("  {v:<22} {n}");
            }
        }
    }
    Ok(if fail && in_code > 0 { ExitCode::from(1) } else { ExitCode::SUCCESS })
}

fn display(p: &Path) -> String {
    p.to_string_lossy().trim_start_matches("./").to_string()
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = if args.is_empty() { String::new() } else { args.remove(0) };
    let result = match cmd.as_str() {
        "snapshot" => snapshot().map(|_| ExitCode::SUCCESS),
        "scan" => {
            let fail = args.iter().any(|a| a == "--fail");
            let json = args.iter().any(|a| a == "--json");
            let paths = args.into_iter().filter(|a| !a.starts_with("--")).map(PathBuf::from).collect();
            scan(paths, fail, json)
        }
        _ => {
            eprintln!("usage: attrition-offline snapshot | scan [--fail] [--json] [path ...]");
            return ExitCode::from(2);
        }
    };
    result.unwrap_or_else(|e| {
        eprintln!("attrition-offline: {e}");
        ExitCode::from(2)
    })
}
