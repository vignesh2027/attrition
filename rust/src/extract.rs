//! Finds OpenTelemetry names in source text: attribute keys, metric names,
//! event names and deprecated enum values. A port of the web extractor
//! (web/lib/extract.ts) so both give the same answer; bench/parity.sh checks it.

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Attribute,
    Metric,
    Event,
}

impl Kind {
    pub fn parse(s: &str) -> Kind {
        match s {
            "metric" => Kind::Metric,
            "event" => Kind::Event,
            _ => Kind::Attribute,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Attribute => "attribute",
            Kind::Metric => "metric",
            Kind::Event => "event",
        }
    }
}

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
    pub kind: Kind,
    /// Set when the finding is a deprecated enum value of the attribute.
    pub value: Option<String>,
    pub line: usize,
    pub column: usize,
    pub form: Form,
    pub span_kind: Option<String>,
}

/// One name from the dataset.
pub struct Entry {
    pub kind: Kind,
    pub key: String,
    pub members: Vec<String>,
    pub deprecated_values: Vec<String>,
}

pub struct Index {
    attributes: HashSet<String>,
    metrics: HashSet<String>,
    events: HashSet<String>,
    by_norm: HashMap<String, Vec<String>>,
    members: HashMap<String, Vec<String>>,
    deprecated_values: HashMap<String, Vec<String>>,
}

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

impl Index {
    pub fn new(entries: impl IntoIterator<Item = Entry>) -> Self {
        let mut idx = Index {
            attributes: HashSet::new(),
            metrics: HashSet::new(),
            events: HashSet::new(),
            by_norm: HashMap::new(),
            members: HashMap::new(),
            deprecated_values: HashMap::new(),
        };
        for e in entries {
            match e.kind {
                Kind::Metric => {
                    idx.metrics.insert(e.key);
                }
                Kind::Event => {
                    idx.events.insert(e.key);
                }
                Kind::Attribute => {
                    idx.by_norm.entry(norm(&e.key)).or_default().push(e.key.clone());
                    if !e.members.is_empty() {
                        idx.members.insert(e.key.clone(), e.members);
                    }
                    if !e.deprecated_values.is_empty() {
                        idx.deprecated_values.insert(e.key.clone(), e.deprecated_values);
                    }
                    idx.attributes.insert(e.key);
                }
            }
        }
        idx
    }

    /// Returns the attribute, the form, and the enum value when it is unique.
    fn resolve_constant(&self, name: &str) -> Option<(String, Form, Option<String>)> {
        let n = norm(name);
        if let Some(keys) = self.by_norm.get(&n)
            && keys.len() == 1
        {
            return Some((keys[0].clone(), Form::Constant, None));
        }
        // Enum value constants: DBSystemRedis -> db.system + "redis"
        for cut in (3..n.len()).rev() {
            let Some(keys) = self.by_norm.get(&n[..cut]) else { continue };
            if keys.len() != 1 {
                continue;
            }
            let rest = &n[cut..];
            let found: Vec<&String> = self.members.get(&keys[0]).map(|m| m.iter().filter(|v| norm(v) == rest).collect()).unwrap_or_default();
            if !found.is_empty() {
                // Old and new values can share one constant name (azure_vm and
                // azure.vm are both CloudPlatformAzureVM), so name it only when unique.
                let value = if found.len() == 1 { Some(found[0].clone()) } else { None };
                return Some((keys[0].clone(), Form::EnumConstant, value));
            }
        }
        None
    }
}

static STRING_LITERAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"["'`]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)["'`]"#).unwrap());
static ANY_LITERAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"["'`]([^"'`\s]{1,64})["'`]"#).unwrap());
static METRIC_CALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)histogram|counter|gauge|meter|instrument|metric").unwrap());
static EVENT_CALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)event|emit|logrecord|log_record").unwrap());
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
        let mut push = |key: String, col: usize, found: Form, kind: Kind, value: Option<String>| {
            if !seen.insert((line, col, kind, key.clone(), value.clone())) {
                return;
            }
            let form = if col >= comment_at { Form::Comment } else { found };
            out.push(Usage { key, kind, value, line, column: col, form, span_kind: nearest_kind(&marks, line) });
        };
        // (attribute, byte offset after which a deprecated value may follow)
        let mut value_checks: Vec<(String, usize)> = Vec::new();

        for c in STRING_LITERAL.captures_iter(text) {
            let m = c.get(0).unwrap();
            let name = &c[1];
            let is_attr = index.attributes.contains(name);
            if index.metrics.contains(name) && (!is_attr || METRIC_CALL.is_match(text)) {
                push(name.to_string(), m.start(), Form::String, Kind::Metric, None);
            } else if index.events.contains(name) && (!is_attr || EVENT_CALL.is_match(text)) {
                push(name.to_string(), m.start(), Form::String, Kind::Event, None);
            } else if is_attr {
                push(name.to_string(), m.start(), Form::String, Kind::Attribute, None);
                value_checks.push((name.to_string(), m.end()));
            }
        }
        for (rx, go_style) in CONSTANTS.iter() {
            for c in rx.captures_iter(text) {
                let raw = &c[1];
                let name = if *go_style { raw.strip_suffix("Key").unwrap_or(raw) } else { raw };
                let Some((key, form, value)) = index.resolve_constant(name) else { continue };
                let m = c.get(0).unwrap();
                push(key.clone(), m.start(), form.clone(), Kind::Attribute, None);
                if let Some(v) = value
                    && index.deprecated_values.get(&key).is_some_and(|d| d.contains(&v))
                {
                    push(key.clone(), m.start(), form.clone(), Kind::Attribute, Some(v));
                }
                if form == Form::Constant {
                    value_checks.push((key, m.end()));
                }
            }
        }
        for (key, after) in value_checks {
            let Some(dep) = index.deprecated_values.get(&key) else { continue };
            let rest = &text[after..];
            for c in ANY_LITERAL.captures_iter(rest) {
                if dep.iter().any(|d| d == &c[1]) {
                    push(key.clone(), after + c.get(0).unwrap().start(), Form::String, Kind::Attribute, Some(c[1].to_string()));
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

    fn entry(kind: Kind, key: &str, members: &[&str], deprecated: &[&str]) -> Entry {
        Entry {
            kind,
            key: key.into(),
            members: members.iter().map(|s| s.to_string()).collect(),
            deprecated_values: deprecated.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn index() -> Index {
        Index::new([
            entry(Kind::Attribute, "db.system", &["redis"], &[]),
            entry(Kind::Attribute, "db.name", &[], &[]),
            entry(Kind::Attribute, "http.request.method", &[], &[]),
            entry(Kind::Attribute, "http.method", &[], &[]),
            entry(Kind::Attribute, "net.peer.name", &[], &[]),
            entry(Kind::Attribute, "cloud.platform", &["azure_vm", "azure.vm"], &["azure_vm"]),
            entry(Kind::Attribute, "cloud.provider", &[], &[]),
            entry(Kind::Attribute, "k8s.pod.status.phase", &[], &[]),
            entry(Kind::Metric, "k8s.pod.status.phase", &[], &[]),
            entry(Kind::Metric, "http.server.duration", &[], &[]),
            entry(Kind::Event, "gen_ai.choice", &[], &[]),
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

    #[test]
    fn metric_and_event_names_are_kept_apart_from_attributes() {
        let code = "const d = meter.createHistogram('http.server.duration', {unit: 'ms'})\nlogger.emit({eventName: 'gen_ai.choice'})\nspan.setAttribute('http.method', 'GET')";
        let got: Vec<_> = extract(code, &index()).into_iter().map(|u| (u.line, u.key, u.kind)).collect();
        assert_eq!(
            got,
            vec![
                (1, "http.server.duration".into(), Kind::Metric),
                (2, "gen_ai.choice".into(), Kind::Event),
                (3, "http.method".into(), Kind::Attribute),
            ]
        );
    }

    #[test]
    fn a_shared_name_is_read_by_its_call() {
        assert_eq!(extract("meter.createGauge('k8s.pod.status.phase')", &index())[0].kind, Kind::Metric);
        assert_eq!(extract("span.setAttribute('k8s.pod.status.phase', 'x')", &index())[0].kind, Kind::Attribute);
    }

    #[test]
    fn deprecated_values_only_next_to_their_key_and_never_when_ambiguous() {
        let code = "r.set(\"cloud.platform\", \"azure_vm\")\nx.set(\"cloud.provider\", \"azure_vm\")\ny := semconv.CloudPlatformAzureVM";
        let got: Vec<_> = extract(code, &index()).into_iter().filter_map(|u| u.value.map(|v| (u.line, u.key, v))).collect();
        assert_eq!(got, vec![(1, "cloud.platform".into(), "azure_vm".into())]);
    }
}
