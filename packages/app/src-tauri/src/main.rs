// Prevents an extra console window on Windows release builds (not a target, harmless).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    devhost_desktop_lib::run()
}
