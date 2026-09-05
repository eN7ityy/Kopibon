//! CDN server rotation + demotion (download-manager.ts:127-134, :257-262,
//! :831-853). Per bare hostname a consecutive non-404 failure counter plus a
//! demoted set; DEMOTE_THRESHOLD = 3; demoted hosts sink to the END of the
//! list (never dropped); one success clears the count and re-promotes; 404s
//! never count. Shared across page batches — the pump owns it.

const DEMOTE_THRESHOLD: u32 = 3;

#[derive(Debug, Default)]
pub struct CdnState {
    failures: std::collections::HashMap<String, u32>,
    demoted: std::collections::HashSet<String>,
}

/// hostOf: strip the protocol prefix.
pub fn host_of(raw: &str) -> String {
    raw.trim_start_matches("https://")
        .trim_start_matches("http://")
        .to_string()
}

impl CdnState {
    pub fn new() -> Self {
        Self::default()
    }

    /// orderServers (:257-262): reliable first, demoted sink to the end.
    pub fn order_servers(&self, servers: &[String]) -> Vec<String> {
        let mut reliable = Vec::new();
        let mut demoted = Vec::new();
        for s in servers {
            if self.demoted.contains(&host_of(s)) {
                demoted.push(s.clone());
            } else {
                reliable.push(s.clone());
            }
        }
        reliable.extend(demoted);
        reliable
    }

    /// A page fetch failure on `server` (never called for 404s).
    pub fn record_failure(&mut self, server: &str) {
        let count = self.failures.entry(server.to_string()).or_insert(0);
        *count += 1;
        if *count >= DEMOTE_THRESHOLD {
            self.demoted.insert(server.to_string());
        }
    }

    /// A success resets the count and re-promotes (:833-837).
    pub fn record_success(&mut self, server: &str) {
        self.failures.remove(server);
        self.demoted.remove(server);
    }

    pub fn is_demoted(&self, server: &str) -> bool {
        self.demoted.contains(server)
    }

    pub fn failure_count(&self, server: &str) -> u32 {
        self.failures.get(server).copied().unwrap_or(0)
    }
}
