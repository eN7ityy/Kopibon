//! The kopibon headless CLI — the Rust side of the differential harness
//! (docs/rust-port/08-subsystem-plans/01 §8): one op per invocation, JSON
//! in, artefact bytes or error strings out. Ops land with their WPs.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "--list-ops" {
        // The differential runner discovers available ops here.
        println!("(no ops yet)");
        return;
    }
    eprintln!("kopibon: no ops implemented yet (WP-A11/A2)");
    std::process::exit(2);
}
