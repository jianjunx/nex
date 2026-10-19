// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--service-mcp") {
        let result = args
            .get(2)
            .ok_or("missing MCP address".to_string())
            .and_then(|address| nex_lib::services::mcp::bridge(address));
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    nex_lib::run();
}
