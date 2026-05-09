use serde::{Deserialize, Serialize};

use crate::schema;

/// Game platform whose traffic the proxy intercepts. Determines which
/// [`crate::bridge::Bridge`] is instantiated per WebSocket flow.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum Platform {
    #[default]
    Majsoul,
    Tenhou,
    Local,
}

impl Platform {
    /// Short name used as a subdirectory under the log session
    /// (e.g. `<session>/<subdir>/<flow>.log`).
    pub fn subdir(self) -> &'static str {
        match self {
            Platform::Majsoul => "majsoul",
            Platform::Tenhou => "tenhou",
            Platform::Local => "local",
        }
    }
}

/// Map the bridge selector to its history-record tag. Keep the two enums
/// separate because the schema enum needs extra variants (`Mjai`, `Unknown`,
/// `RiichiCity`) that don't make sense as a runtime bridge selector.
impl From<Platform> for schema::Platform {
    fn from(p: Platform) -> Self {
        match p {
            Platform::Majsoul => schema::Platform::Majsoul,
            Platform::Tenhou => schema::Platform::Tenhou,
            Platform::Local => schema::Platform::Local,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlatformConfig {
    pub kind: Platform,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_to_schema_platform_round_trip() {
        assert_eq!(
            schema::Platform::from(Platform::Majsoul),
            schema::Platform::Majsoul
        );
        assert_eq!(
            schema::Platform::from(Platform::Tenhou),
            schema::Platform::Tenhou
        );
        assert_eq!(
            schema::Platform::from(Platform::Local),
            schema::Platform::Local
        );
    }
}
