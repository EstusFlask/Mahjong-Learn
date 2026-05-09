//! Platform-specific protocol bridges.
//!
//! A `Bridge` translates between a game platform's wire protocol and the
//! mjai JSONL event stream consumed by AI bots. One bridge instance per
//! independent game session (e.g. one Majsoul WebSocket flow).

pub mod majsoul;
pub mod tenhou;

pub use majsoul::MajsoulBridge;
pub use tenhou::TenhouBridge;

use crate::{
    logger::{FlowLogger, Session},
    schema::{MjaiEvent, ParsedFrame},
};
use std::sync::Arc;

/// Direction of a parsed frame relative to the proxied client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Client → server (uplink, e.g. requests).
    Up,
    /// Server → client (downlink, e.g. responses, notifies).
    Down,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Up => "up",
            Direction::Down => "down",
        }
    }
}

/// Result of parsing one wire frame.
///
/// `events` are the mjai events the frame translated into (zero or more).
/// `parsed` is the bridge's first-pass structured view of the frame —
/// Majsoul's decoded protobuf method+payload, Tenhou's `{tag, …}` JSON
/// dict — surfaced for the inspector so a developer can see what the
/// bridge thought the frame meant. Bridges that can't decode a particular
/// frame (handshake, unsupported method, malformed payload) return `None`.
#[derive(Debug, Clone, Default)]
pub struct ParseResult {
    pub events: Vec<MjaiEvent>,
    pub parsed: Option<ParsedFrame>,
}

impl ParseResult {
    pub fn empty() -> Self {
        Self::default()
    }
    pub fn just_events(events: Vec<MjaiEvent>) -> Self {
        Self { events, parsed: None }
    }
}

/// Translates raw platform frames to mjai events and vice-versa.
pub trait Bridge: Send {
    /// Parse a raw platform frame into zero or more mjai events plus an
    /// optional structured view for the inspector.
    fn parse(&mut self, direction: Direction, content: &[u8]) -> ParseResult;

    /// Build a raw platform frame from an mjai command, if applicable.
    fn build(&mut self, command: &MjaiEvent) -> Option<Vec<u8>>;
}

struct NoopBridge;

impl Bridge for NoopBridge {
    fn parse(&mut self, _direction: Direction, _content: &[u8]) -> ParseResult {
        ParseResult::empty()
    }

    fn build(&mut self, _command: &MjaiEvent) -> Option<Vec<u8>> {
        None
    }
}

/// Construct a bridge for the given platform.
///
/// - `flow_log`: per-WS-flow text dump (one JSON line per parsed message).
/// - `session`: passed through to bridges that open additional log files
///   on demand (e.g. Majsoul rotates a fresh `*.mjai.jsonl` per game).
pub fn for_platform(
    platform: crate::config::Platform,
    flow_log: Option<Arc<FlowLogger>>,
    session: Option<Arc<Session>>,
) -> Box<dyn Bridge> {
    match platform {
        crate::config::Platform::Majsoul => Box::new(MajsoulBridge::new(flow_log, session)),
        crate::config::Platform::Tenhou => Box::new(TenhouBridge::new(flow_log, session)),
        crate::config::Platform::Local => Box::new(NoopBridge),
    }
}
