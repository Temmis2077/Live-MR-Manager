fn main() {
    let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("generated")
        .join("ipc.ts");
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).expect("create generated IPC directory");
    }
    tauri_app_lib::ipc::export_typescript(&output).expect("export TypeScript IPC bindings");
    println!("{}", output.display());
}

