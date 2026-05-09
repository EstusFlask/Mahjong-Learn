//! Persisted game-history records.
//!
//! `GameRecord` is what `crate::history::recorder` writes to
//! `<history_root>/index.jsonl` (one JSON line per finalised game) and what
//! the frontend reads back via Tauri commands. It mirrors the shape of
//! `reference/Mortal/libriichi/src/stat.rs::Stat` for per-game counts so
//! summing across records gives stat-equivalent aggregates.
//!
//! Wire format is internally-tagged where useful (`Platform`, `KyokuMode`,
//! `HistoryEvent`) to keep the JSON shape stable as variants are added.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::schema::MjaiEvent;

// ---------- Platform / KyokuMode ----------

/// Bridge that produced the record. `Unknown` is the safety net for a
/// future bridge whose tag is added before the schema knows about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Majsoul,
    Tenhou,
    Local,
    RiichiCity,
    Mjai,
    Unknown,
}

/// Game length, derived from the highest `bakaze` seen in `start_kyoku`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KyokuMode {
    /// Only `"E"` rounds — tonpuu (east-only).
    EastOnly,
    /// At least one `"S"` round — hanchan (east-south).
    EastSouth,
    /// Saw `"W"` or `"N"` — west / north overtime, treated as hanchan
    /// for scoring (Majsoul never uses these except as continuation).
    Other,
}

// ---------- GameStats ----------

/// Per-game counters mirroring `libriichi::stat::Stat`. All fields are
/// from the *recorded player's* perspective. Summing across records
/// (frontend aggregation) yields the same numbers `stat.rs` would
/// compute when processing the underlying mjai logs directly.
///
/// Δscore semantics follow the reference notes:
/// - Riichi Δscores cover all kyotaku *except* the 1000-point sengenhai
///   stake of the riichi declaration itself.
/// - Every other Δscore covers all kyotaku.
/// - Ankan does not count as fuuro.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameStats {
    pub round: i64,
    pub oya: i64,

    pub fuuro: i64,
    pub fuuro_num: i64,
    pub fuuro_point: i64,
    pub fuuro_agari: i64,
    pub fuuro_agari_jun: i64,
    pub fuuro_agari_point: i64,
    pub fuuro_houjuu: i64,

    pub agari: i64,
    pub agari_as_oya: i64,
    pub agari_jun: i64,
    pub agari_point_oya: i64,
    pub agari_point_ko: i64,

    pub houjuu: i64,
    pub houjuu_jun: i64,
    pub houjuu_to_oya: i64,
    pub houjuu_point_to_oya: i64,
    pub houjuu_point_to_ko: i64,

    pub riichi: i64,
    pub riichi_as_oya: i64,
    pub riichi_jun: i64,
    pub riichi_agari: i64,
    pub riichi_agari_point: i64,
    pub riichi_agari_jun: i64,
    pub riichi_houjuu: i64,
    pub riichi_ryukyoku: i64,
    pub riichi_point: i64,
    pub chasing_riichi: i64,
    pub riichi_got_chased: i64,

    pub dama_agari: i64,
    pub dama_agari_jun: i64,
    pub dama_agari_point: i64,

    pub ryukyoku: i64,
    pub ryukyoku_point: i64,

    pub yakuman: i64,
    pub nagashi_mangan: i64,
}

// ---------- GameRecord ----------

/// One finalised game persisted to `index.jsonl`. The full mjai event
/// stream is stored separately at `games/<id>.mjai.jsonl` (see
/// `log_path`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameRecord {
    /// ULID; lexicographically sortable by start time. Doubles as
    /// filename stem under `games/`.
    pub id: String,

    /// Wall-clock time the recorder saw the game's first event.
    pub started_at: DateTime<Utc>,
    /// Wall-clock time `EndGame` arrived.
    pub ended_at: DateTime<Utc>,

    pub platform: Platform,
    /// 3 (sanma) or 4 (yonma).
    pub num_players: u8,
    pub kyoku_mode: KyokuMode,

    /// Player display names, indexed by seat (length = `num_players`).
    pub names: Vec<String>,

    /// The recorded player's seat, taken from `start_game.id`. `None`
    /// when the bridge was in observer/replay mode and no own-seat was
    /// declared — in that case `our_rank`/`our_delta` are also `None`
    /// and the frontend skips the game in cumulative-PT charts.
    pub our_seat: Option<u8>,

    /// Final scores per seat, after Mortal-style 100k normalisation
    /// (4p) or 105k (3p). Length = `num_players`.
    pub final_scores: Vec<i32>,

    /// Final rank (1..=num_players) per seat. Computed by `Rankings`
    /// (descending score, ascending seat tiebreak).
    pub final_ranks: Vec<u8>,

    pub our_rank: Option<u8>,
    /// `final_score[our_seat] - starting_score`. Starting = 25_000 (4p)
    /// / 35_000 (3p). Used by frontend PT formulas as the "(score-25000)
    /// /1000" base term.
    pub our_delta: Option<i32>,

    pub stats: GameStats,

    /// Path of the mjai.jsonl copy, relative to the history root —
    /// always `"games/<id>.mjai.jsonl"`.
    pub log_path: String,
}

// ---------- HistoryFilter ----------

/// Filter for `list_game_history` / `get_game_history_aggregate`. All
/// fields are optional — `Default` matches everything.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HistoryFilter {
    pub platform: Option<Platform>,
    /// 3 or 4. Filters by `num_players`.
    pub num_players: Option<u8>,
    pub kyoku_mode: Option<KyokuMode>,
    /// Inclusive lower bound on `started_at`.
    pub started_after: Option<DateTime<Utc>>,
    /// Exclusive upper bound on `started_at`.
    pub started_before: Option<DateTime<Utc>>,
}

impl HistoryFilter {
    /// True when `record` passes every populated filter clause.
    pub fn matches(&self, record: &GameRecord) -> bool {
        if let Some(p) = self.platform {
            if record.platform != p {
                return false;
            }
        }
        if let Some(n) = self.num_players {
            if record.num_players != n {
                return false;
            }
        }
        if let Some(m) = self.kyoku_mode {
            if record.kyoku_mode != m {
                return false;
            }
        }
        if let Some(after) = self.started_after {
            if record.started_at < after {
                return false;
            }
        }
        if let Some(before) = self.started_before {
            if record.started_at >= before {
                return false;
            }
        }
        true
    }
}

// ---------- HistoryEvent ----------

/// Backend → frontend notification when a new record lands. Forwarded as
/// the Tauri `history-recorded` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HistoryEvent {
    /// A finalised game was just appended to the index. Payload is the
    /// full record so the frontend can prepend without an extra fetch.
    Recorded { record: Box<GameRecord> },
    /// A record (and its mjai log copy) was deleted via the IPC command.
    Deleted { id: String },
}

// ---------- HistoryEventLog ----------

/// On-disk shape of `games/<id>.mjai.jsonl` — exactly the buffered mjai
/// stream of a finalised game. Type alias kept to make the storage
/// contract explicit.
pub type HistoryEventLog = Vec<MjaiEvent>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_round_trips_lowercase() {
        let j = serde_json::to_string(&Platform::Majsoul).unwrap();
        assert_eq!(j, "\"majsoul\"");
        let back: Platform = serde_json::from_str(&j).unwrap();
        assert_eq!(back, Platform::Majsoul);
    }

    #[test]
    fn kyoku_mode_round_trips() {
        for m in [KyokuMode::EastOnly, KyokuMode::EastSouth, KyokuMode::Other] {
            let j = serde_json::to_string(&m).unwrap();
            let back: KyokuMode = serde_json::from_str(&j).unwrap();
            assert_eq!(back, m);
        }
    }

    #[test]
    fn history_filter_default_matches_everything() {
        let r = GameRecord {
            id: "01ARZ".into(),
            started_at: Utc::now(),
            ended_at: Utc::now(),
            platform: Platform::Majsoul,
            num_players: 4,
            kyoku_mode: KyokuMode::EastOnly,
            names: vec!["a".into(), "b".into(), "c".into(), "d".into()],
            our_seat: Some(0),
            final_scores: vec![30000, 25000, 25000, 20000],
            final_ranks: vec![1, 2, 3, 4],
            our_rank: Some(1),
            our_delta: Some(5000),
            stats: GameStats::default(),
            log_path: "games/01ARZ.mjai.jsonl".into(),
        };
        assert!(HistoryFilter::default().matches(&r));
    }

    #[test]
    fn history_filter_platform_mismatch() {
        let r = GameRecord {
            id: "x".into(),
            started_at: Utc::now(),
            ended_at: Utc::now(),
            platform: Platform::Majsoul,
            num_players: 4,
            kyoku_mode: KyokuMode::EastOnly,
            names: vec![],
            our_seat: None,
            final_scores: vec![],
            final_ranks: vec![],
            our_rank: None,
            our_delta: None,
            stats: GameStats::default(),
            log_path: "x".into(),
        };
        let f = HistoryFilter {
            platform: Some(Platform::Tenhou),
            ..Default::default()
        };
        assert!(!f.matches(&r));
    }

    #[test]
    fn history_event_recorded_round_trips() {
        let rec = GameRecord {
            id: "rec1".into(),
            started_at: Utc::now(),
            ended_at: Utc::now(),
            platform: Platform::Majsoul,
            num_players: 4,
            kyoku_mode: KyokuMode::EastSouth,
            names: vec!["a".into(), "b".into(), "c".into(), "d".into()],
            our_seat: Some(2),
            final_scores: vec![25000, 25000, 25000, 25000],
            final_ranks: vec![1, 2, 3, 4],
            our_rank: Some(3),
            our_delta: Some(0),
            stats: GameStats::default(),
            log_path: "games/rec1.mjai.jsonl".into(),
        };
        let ev = HistoryEvent::Recorded {
            record: Box::new(rec),
        };
        let j = serde_json::to_string(&ev).unwrap();
        assert!(j.contains(r#""kind":"recorded""#));
        let back: HistoryEvent = serde_json::from_str(&j).unwrap();
        assert_eq!(back, ev);
    }
}
