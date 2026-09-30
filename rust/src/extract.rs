//! Finds OpenTelemetry attribute usage in source text. A port of the web
//! extractor (web/lib/extract.ts) so both give the same answer.

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq)]
pub enum Form {
    String,
    Constant,
    EnumConstant,
    Comment,
}

#[derive(Debug, Clone)]
pub struct Usage {
    pub key: String,
    pub line: usize,
    pub column: usize,
    pub form: Form,
    pub span_kind: Option<String>,
}

pub struct Index {
    pub keys: HashSet<String>,
    by_norm: HashMap<String, Vec<String>>,
    members: HashMap<String, Vec<String>>,
}

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

impl Index {
    pub fn new(entries: impl IntoIterator<Item = (String, Vec<String>)>) -> Self {
        let mut idx = Index { keys: HashSet::new(), by_norm: HashMap::new(), members: HashMap::new() };
        for (key, members) in entries {
            idx.by_norm.entry(norm(&key)).or_default().push(key.clone());
            if !members.is_empty() {
                idx.members.insert(key.clone(), members);
            }
            idx.keys.insert(key);
        }
        idx
    }

    fn resolve_constant(&self, name: &str) -> Option<(String, Form)> {
        let n = norm(name);
        if let Some(keys) = self.by_norm.get(&n)
            && keys.len() == 1 {
                return Some((keys[0].clone(), Form::Constant));
            }
        // Enum value constants: DBSystemRedis -> db.system + "redis"
        for cut in (3..n.len()).rev() {
            let Some(keys) = self.by_norm.get(&n[..cut]) else { continue };
            if keys.len() != 1 {
                continue;
            }
            let rest = &n[cut..];
            if self.members.get(&keys[0]).is_some_and(|m| m.iter().any(|v| norm(v) == rest)) {
                return Some((keys[0].clone(), Form::EnumConstant));
            }
        }
        None
    }
}

static STRING_LITERAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"["'`]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)["'`]"#).unwrap());
static CONSTANTS: LazyLock<Vec<(Regex, bool)>> = LazyLock::new(|| {
    vec![
        (Regex::new(r"\b(?:ATTR|SEMATTRS|SEMRESATTRS)_([A-Z0-9_]+)\b").unwrap(), false),
        (Regex::new(r"\b\w*(?:Attributes|Attrs)\.([A-Z][A-Z0-9_]+)\b").unwrap(), false),
        (Regex::new(r"\bsemconv\.([A-Z][A-Za-z0-9]+)\b").unwrap(), true),
    ]
});
static SPAN_KINDS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r"SpanKind(Client|Server|Producer|Consumer|Internal)\b").unwrap(),
        Regex::new(r"SpanKind\.(CLIENT|SERVER|PRODUCER|CONSUMER|INTERNAL)\b").unwrap(),
        Regex::new(r"SPAN_KIND_(CLIENT|SERVER|PRODUCER|CONSUMER|INTERNAL)\b").unwrap(),
        Regex::new(r#"(?i)\bkind\s*[:=]\s*["'](client|server|producer|consumer|internal)["']"#).unwrap(),
    ]
});
static IMPORT_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(import\b|from\s+[\w.]+\s+import\b)").unwrap());
static IMPORT_FROM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\bfrom\s+["'][^"']+["']"#).unwrap());
static LINE_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(//|#|\*|/\*|--)").unwrap());
static TRAILING_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s(//|#)\s").unwrap());

fn import_lines(lines: &[&str]) -> HashSet<usize> {
    let mut out = HashSet::new();
    let mut open = false;
    for (i, text) in lines.iter().enumerate() {
        let t = text.trim();
        let starts = IMPORT_START.is_match(t);
        if starts || open {
            out.insert(i + 1);
            let closes = IMPORT_FROM.is_match(t)
                || (t.ends_with(')') && !t.ends_with('('))
                || (starts && !(t.ends_with('(') || t.ends_with('{')));
            open = !closes;
        }
    }
    out
}

fn nearest_kind(marks: &[(usize, String)], line: usize) -> Option<String> {
    let before = marks.iter().filter(|(l, _)| *l <= line && line - *l <= 60).max_by_key(|(l, _)| *l);
    if let Some((_, k)) = before {
        return Some(k.clone());
    }
    marks.iter().filter(|(l, _)| *l > line && *l - line <= 8).min_by_key(|(l, _)| *l).map(|(_, k)| k.clone())
}

pub fn extract(code: &str, index: &Index) -> Vec<Usage> {
    let lines: Vec<&str> = code.split('\n').collect();
    let mut marks = Vec::new();
    for (i, text) in lines.iter().enumerate() {
        for rx in SPAN_KINDS.iter() {
            for c in rx.captures_iter(text) {
                marks.push((i + 1, c[1].to_ascii_lowercase()));
            }
        }
    }
    let imports = import_lines(&lines);
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for (i, text) in lines.iter().enumerate() {
        let line = i + 1;
        if imports.contains(&line) {
            continue;
        }
        let comment_at = if LINE_COMMENT.is_match(text.trim_start()) {
            0
        } else {
            TRAILING_COMMENT.find(text).map(|m| m.start()).unwrap_or(usize::MAX)
        };
        let mut push = |key: String, col: usize, found: Form| {
            if !seen.insert((line, col, key.clone())) {
                return;
            }
            let form = if col >= comment_at { Form::Comment } else { found };
            out.push(Usage { key, line, column: col, form, span_kind: nearest_kind(&marks, line) });
        };
        for c in STRING_LITERAL.captures_iter(text) {
            let m = c.get(0).unwrap();
            if index.keys.contains(&c[1]) {
                push(c[1].to_string(), m.start(), Form::String);
            }
        }
        for (rx, go_style) in CONSTANTS.iter() {
            for c in rx.captures_iter(text) {
                let raw = &c[1];
                let name = if *go_style { raw.strip_suffix("Key").unwrap_or(raw) } else { raw };
                if let Some((key, form)) = index.resolve_constant(name) {
                    push(key, c.get(0).unwrap().start(), form);
                }
            }
        }
    }
    out.sort_by_key(|u| (u.line, u.column));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> Index {
        Index::new([
            ("db.system".to_string(), vec!["redis".to_string()]),
            ("db.name".to_string(), vec![]),
            ("http.request.method".to_string(), vec![]),
            ("net.peer.name".to_string(), vec![]),
        ])
    }

    #[test]
    fn finds_strings_constants_and_enum_constants() {
        let code = "package x\nfunc f() {\n\t_ = semconv.DBSystemRedis\n\t_ = semconv.HTTPRequestMethodKey\n\tattribute.String(\"db.system\", \"a\")\n}\n";
        let got: Vec<_> = extract(code, &index()).into_iter().map(|u| (u.line, u.key, u.form)).collect();
        assert_eq!(
            got,
            vec![
                (3, "db.system".into(), Form::EnumConstant),
                (4, "http.request.method".into(), Form::Constant),
                (5, "db.system".into(), Form::String),
            ]
        );
    }

    #[test]
    fn assigns_span_kind_and_skips_imports_and_marks_comments() {
        let code = "import {\n  SEMATTRS_NET_PEER_NAME,\n} from '@opentelemetry/semantic-conventions'\nstartSpan('x', {kind: SpanKind.SERVER})\nspan.setAttribute(SEMATTRS_NET_PEER_NAME, h) // was \"db.name\"\n";
        let got = extract(code, &index());
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].key, "net.peer.name");
        assert_eq!(got[0].span_kind.as_deref(), Some("server"));
        assert_eq!(got[1].form, Form::Comment);
    }
}
