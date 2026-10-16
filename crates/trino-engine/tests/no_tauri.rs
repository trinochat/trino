//! The engine has no Tauri in it (M4-0): the mobile apps take it through
//! FFI, where there is no Tauri, and the desktop app's commands only wrap
//! it. Its whole dependency tree is asked, for every target and with
//! normal, build and dev dependencies, so a crate that brings Tauri in
//! through a platform or a test fails here too.

/// Tauri and the window and webview crates that only come with it.
fn is_tauri(name: &str) -> bool {
    name == "tauri" || name.starts_with("tauri-") || name == "wry" || name == "tao"
}

#[test]
fn the_engine_has_no_tauri_in_its_dependency_tree() {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let out = std::process::Command::new(&cargo)
        .args(["tree", "--locked", "--manifest-path"])
        .arg(&manifest)
        .args(["-p", "trino-engine", "--target", "all"])
        .args(["-e", "normal,build,dev", "--prefix", "none"])
        .args(["--format", "{p}"])
        .output()
        .expect("cargo runs");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "cargo tree failed\n{stderr}");
    let packages: Vec<&str> = stdout
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .collect();
    assert!(
        packages.contains(&"trino-engine"),
        "the tree was not read\n{stdout}"
    );
    let tauri: Vec<&str> = packages.into_iter().filter(|name| is_tauri(name)).collect();
    assert!(tauri.is_empty(), "Tauri in the engine: {tauri:?}\n{stdout}");
}

#[test]
fn the_check_knows_tauri_and_its_window_crates() {
    for name in [
        "tauri",
        "tauri-runtime-wry",
        "tauri-plugin-opener",
        "wry",
        "tao",
    ] {
        assert!(is_tauri(name), "{name}");
    }
    for name in ["trino-net", "tokio", "taoism", "wry-not", "tauri_like"] {
        assert!(!is_tauri(name), "{name}");
    }
}
