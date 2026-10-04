fn main() {
    let mut attributes = tauri_build::Attributes::new();
    // tauri-build embeds its Common-Controls v6 manifest into the app binary
    // only; the unit-test harness links the same code (TaskDialogIndirect)
    // and without the manifest Windows refuses to start it
    // (STATUS_ENTRYPOINT_NOT_FOUND). The same manifest is embedded through
    // the linker instead, into every target.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
