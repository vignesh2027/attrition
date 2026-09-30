# attrition-offline (Rust)

The Attrition scanner with no network at scan time. It downloads the public Sanity
dataset once, then checks files locally. Built for pre-commit hooks and air-gapped CI.

```sh
cargo build --release
./target/release/attrition-offline snapshot              # saves .attrition/snapshot.json (no token needed)
./target/release/attrition-offline scan src/             # report
./target/release/attrition-offline scan --fail $(git diff --cached --name-only)   # pre-commit
./target/release/attrition-offline scan --json .         # machine-readable
```

`src/extract.rs` is a port of the web extractor (`web/lib/extract.ts`): string keys, SDK
constants in Go, TypeScript, Java and Python, Go enum constants, span kind, import lines
and comments. `bench/parity.sh` runs both on the five benchmark repositories; they agree
on every count (100 usages in code, 2 in comments), and the Rust scanner covers the 1,324
files in under 600 ms.
