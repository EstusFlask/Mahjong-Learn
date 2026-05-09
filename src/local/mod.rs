//! Built-in local riichi mahjong table.
//!
//! The local table is intentionally wired through the same mjai stream as
//! captured platforms: the engine advances a real `riichienv_core` game,
//! masks the stream to the human player's perspective, and emits those
//! events on `MjaiBus`. Analysis, the live tracker, bot recommendations and
//! history therefore keep working without a parallel code path.

use crate::bot::manifest;
use crate::bot::{
    BotEntry, BotRegistry, BotResponse, BotRunner, PythonRuntime, SubprocessBot, SyncGuard,
};
use crate::event_bus::{BotResponseBus, MjaiBus, NotifyBus};
use crate::game_state::snapshot::GameStateSnapshot;
use crate::inspector::InspectorWriter;
use crate::schema::{BotReaction, InspectorEntry, MjaiEvent, Notification};
use crate::util::resolve_dir;
use anyhow::{bail, Context, Result};
use chrono::Local;
use riichienv_core::action::{Action, ActionType, Phase};
use riichienv_core::parser::{mjai_to_tid, tid_to_mjai};
use riichienv_core::rule::GameRule;
use riichienv_core::state::legal_actions::GameStateLegalActions;
use riichienv_core::state::GameState;
use riichienv_core::state_3p::legal_actions::GameState3PLegalActions;
use riichienv_core::state_3p::GameState3P;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, warn};

const HUMAN_SEAT: u8 = 0;
const DEFAULT_4P_BOT: &str = "mortal";
const DEFAULT_3P_BOT: &str = "mortal3p";
const MAX_AUTO_STEPS: usize = 4_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalGameMode {
    FourEast,
    FourHanchan,
    ThreeEast,
    ThreeHanchan,
}

impl LocalGameMode {
    pub fn num_players(self) -> u8 {
        match self {
            Self::FourEast | Self::FourHanchan => 4,
            Self::ThreeEast | Self::ThreeHanchan => 3,
        }
    }

    fn game_mode_id(self) -> u8 {
        match self {
            Self::FourEast => 1,
            Self::FourHanchan => 2,
            Self::ThreeEast => 4,
            Self::ThreeHanchan => 5,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocalGameStartRequest {
    pub mode: Option<LocalGameMode>,
    #[serde(default)]
    pub bot_4p: Option<String>,
    #[serde(default)]
    pub bot_3p: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalActionKind {
    Discard,
    Chi,
    Pon,
    Daiminkan,
    Ron,
    Riichi,
    Tsumo,
    Pass,
    Ankan,
    Kakan,
    KyushuKyuhai,
    Kita,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalActionView {
    pub id: String,
    pub kind: LocalActionKind,
    pub actor: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<String>,
    #[serde(default)]
    pub consumed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalGameView {
    pub mode: LocalGameMode,
    pub bot_4p: String,
    pub bot_3p: String,
    pub names: Vec<String>,
    pub snapshot: GameStateSnapshot,
    pub legal_actions: Vec<LocalActionView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Default)]
pub struct LocalGameManager {
    game: Option<LocalGame>,
}

pub struct LocalRuntime<'a> {
    pub runtime: Option<&'a PythonRuntime>,
    pub bot_dir: &'a str,
    pub syncs_in_flight: Arc<Mutex<HashSet<String>>>,
}

pub struct LocalBuses<'a> {
    pub mjai: &'a MjaiBus,
    pub bot_response: &'a BotResponseBus,
    pub notify: &'a NotifyBus,
    pub inspector: InspectorWriter,
}

impl LocalGameManager {
    pub async fn start(
        &mut self,
        req: LocalGameStartRequest,
        cfg: &crate::config::AppConfig,
        runtime: LocalRuntime<'_>,
        buses: LocalBuses<'_>,
    ) -> Result<LocalGameView> {
        let mode = req.mode.unwrap_or(LocalGameMode::FourEast);
        let bot_4p = choose_bot(req.bot_4p, &cfg.bot.active_4p, DEFAULT_4P_BOT);
        let bot_3p = choose_bot(req.bot_3p, &cfg.bot.active_3p, DEFAULT_3P_BOT);
        let chosen_bot = if mode.num_players() == 3 {
            bot_3p.clone()
        } else {
            bot_4p.clone()
        };

        let mut game = LocalGame::new(mode, bot_4p, bot_3p, chosen_bot);
        game.spawn_bots(runtime).await?;
        game.emit_start_game(buses.mjai);
        game.collect_and_emit(buses.mjai);
        game.advance_until_human(&buses).await?;
        let view = game.view();
        self.game = Some(game);
        Ok(view)
    }

    pub async fn submit_action(
        &mut self,
        action_id: String,
        buses: LocalBuses<'_>,
    ) -> Result<LocalGameView> {
        let game = self
            .game
            .as_mut()
            .context("no local game is running")?;
        let action = game
            .latest_human_actions
            .iter()
            .find(|a| action_id(a) == action_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("local action is no longer legal"))?;

        let mut actions = HashMap::new();
        actions.insert(HUMAN_SEAT, action);

        // In a claim window, bots may also be deciding on the same discard /
        // kakan / kita. Submit everyone together so ron and call priority is
        // resolved by the rules engine, not by UI timing.
        if game.engine.phase() == Phase::WaitResponse {
            let bot_actions = game.response_actions_from_bots(&buses).await?;
            for (seat, act) in bot_actions {
                actions.insert(seat, act);
            }
        }

        game.engine.step(&actions);
        game.collect_and_emit(buses.mjai);
        game.advance_until_human(&buses).await?;
        Ok(game.view())
    }

    pub fn view(&self) -> Option<LocalGameView> {
        self.game.as_ref().map(LocalGame::view)
    }

    pub fn stop(&mut self) {
        self.game = None;
    }
}

struct LocalGame {
    mode: LocalGameMode,
    bot_4p: String,
    bot_3p: String,
    names: Vec<String>,
    engine: LocalEngine,
    bots: Vec<LocalSeatBot>,
    latest_human_actions: Vec<Action>,
    emitted_log_len: usize,
    message: Option<String>,
}

impl LocalGame {
    fn new(mode: LocalGameMode, bot_4p: String, bot_3p: String, chosen_bot: String) -> Self {
        let rule = GameRule::default_tenhou();
        let engine = if mode.num_players() == 3 {
            LocalEngine::Three(GameState3P::new(
                mode.game_mode_id(),
                false,
                None,
                0,
                rule,
            ))
        } else {
            LocalEngine::Four(GameState::new(mode.game_mode_id(), false, None, 0, rule))
        };
        let names = (0..mode.num_players())
            .map(|seat| {
                if seat == HUMAN_SEAT {
                    "Player".to_string()
                } else {
                    format!("{chosen_bot} {seat}")
                }
            })
            .collect();
        Self {
            mode,
            bot_4p,
            bot_3p,
            names,
            engine,
            bots: Vec::new(),
            latest_human_actions: Vec::new(),
            emitted_log_len: 0,
            message: None,
        }
    }

    async fn spawn_bots(&mut self, local_runtime: LocalRuntime<'_>) -> Result<()> {
        let bot_runtime = local_runtime
            .runtime
            .ok_or_else(|| anyhow::anyhow!("Python runtime not available; bots cannot be launched"))?;
        let root = resolve_dir(Path::new(local_runtime.bot_dir));
        let registry = BotRegistry::scan(&root)
            .with_context(|| format!("scan bot registry at {}", root.display()))?;
        let bot_name = if self.mode.num_players() == 3 {
            self.bot_3p.clone()
        } else {
            self.bot_4p.clone()
        };
        let entry = registry
            .find(&bot_name)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("bot {bot_name:?} not found at {}", root.display()))?;

        for seat in 1..self.mode.num_players() {
            let runner = spawn_bot_for_seat(
                bot_runtime,
                &entry,
                seat,
                local_runtime.syncs_in_flight.clone(),
            )
            .await?;
            self.bots.push(LocalSeatBot {
                seat,
                name: bot_name.clone(),
                runner,
                pending: Vec::new(),
            });
        }
        Ok(())
    }

    fn emit_start_game(&mut self, mjai: &MjaiBus) {
        let ev = MjaiEvent::StartGame {
            names: self.names.clone(),
            kyoku_first: Some(0),
            aka_flag: Some(true),
            id: Some(HUMAN_SEAT),
            num_players: self.mode.num_players(),
        };
        self.feed_bots(&ev);
        let _ = mjai.send(ev);
    }

    fn collect_and_emit(&mut self, mjai: &MjaiBus) {
        let lines = self.engine.logs_from(self.emitted_log_len);
        self.emitted_log_len += lines.len();
        for line in lines {
            let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
                warn!("local engine emitted malformed mjai line: {line}");
                continue;
            };
            let Some(kind) = value.get("type").and_then(Value::as_str) else {
                continue;
            };
            if kind == "start_game" {
                continue;
            }
            if kind == "start_kyoku" {
                if let Some(obj) = value.as_object_mut() {
                    obj.insert(
                        "num_players".to_string(),
                        Value::Number(self.mode.num_players().into()),
                    );
                }
            }
            let full_event = match serde_json::from_value::<MjaiEvent>(value) {
                Ok(ev) => ev,
                Err(e) => {
                    warn!("local engine mjai line did not match schema: {e:#}; line={line}");
                    continue;
                }
            };
            self.feed_bots(&full_event);
            let human_event = event_for_seat(&full_event, HUMAN_SEAT);
            let _ = mjai.send(human_event);
        }
    }

    fn feed_bots(&mut self, event: &MjaiEvent) {
        for bot in &mut self.bots {
            bot.pending.push(event_for_seat(event, bot.seat));
        }
    }

    async fn advance_until_human(&mut self, buses: &LocalBuses<'_>) -> Result<()> {
        self.message = None;
        for _ in 0..MAX_AUTO_STEPS {
            if self.engine.is_done() {
                self.latest_human_actions.clear();
                return Ok(());
            }
            if self.engine.needs_initialize_next_round() {
                self.engine.step(&HashMap::new());
                self.collect_and_emit(buses.mjai);
                continue;
            }
            if self.human_has_decision() {
                self.latest_human_actions = self.engine.legal_actions(HUMAN_SEAT);
                return Ok(());
            }

            let actions = match self.engine.phase() {
                Phase::WaitAct => {
                    let seat = self.engine.current_player();
                    let Some(action) = self.action_from_bot(seat, buses).await? else {
                        self.message = Some(format!("bot at seat {seat} has no legal action"));
                        self.latest_human_actions.clear();
                        return Ok(());
                    };
                    HashMap::from([(seat, action)])
                }
                Phase::WaitResponse => self.response_actions_from_bots(buses).await?,
            };

            if actions.is_empty() {
                self.message = Some("local engine waited without any active bot".to_string());
                self.latest_human_actions.clear();
                return Ok(());
            }

            self.engine.step(&actions);
            self.collect_and_emit(buses.mjai);
        }
        bail!("local game auto loop exceeded {MAX_AUTO_STEPS} steps")
    }

    fn human_has_decision(&self) -> bool {
        match self.engine.phase() {
            Phase::WaitAct => self.engine.current_player() == HUMAN_SEAT,
            Phase::WaitResponse => self.engine.active_players().contains(&HUMAN_SEAT),
        }
    }

    async fn response_actions_from_bots(
        &mut self,
        buses: &LocalBuses<'_>,
    ) -> Result<HashMap<u8, Action>> {
        let mut out = HashMap::new();
        for seat in self.engine.active_players() {
            if seat == HUMAN_SEAT {
                continue;
            }
            if let Some(action) = self.action_from_bot(seat, buses).await? {
                out.insert(seat, action);
            }
        }
        Ok(out)
    }

    async fn action_from_bot(
        &mut self,
        seat: u8,
        buses: &LocalBuses<'_>,
    ) -> Result<Option<Action>> {
        let legal = self.engine.legal_actions(seat);
        if legal.is_empty() {
            return Ok(None);
        }
        let Some(bot) = self.bots.iter_mut().find(|b| b.seat == seat) else {
            return Ok(fallback_action(&legal));
        };

        let batch = std::mem::take(&mut bot.pending);
        let trigger = batch.last().cloned().unwrap_or(MjaiEvent::None);
        let started = std::time::Instant::now();
        let resp = match bot.runner.react(&batch).await {
            Ok(resp) => resp,
            Err(e) => {
                let msg = format!("local bot {} (seat {}) failed: {e:#}", bot.name, bot.seat);
                let _ = buses.notify.send(Notification::warn("Local bot failed").body(msg));
                return Ok(fallback_action(&legal));
            }
        };
        let reaction_ms = started.elapsed().as_millis() as u64;
        debug!(
            bot = %bot.name,
            seat = bot.seat,
            action = ?resp.action,
            reaction_ms,
            "local bot reacted"
        );
        let _ = buses.bot_response.send(resp.clone());
        buses.inspector.record(InspectorEntry::BotReaction {
            ts_ms: Local::now().timestamp_millis(),
            reaction: BotReaction {
                bot: bot.name.clone(),
                actor_id: bot.seat,
                trigger,
                action: resp.action.clone(),
                meta: resp.meta.clone(),
                reaction_ms,
            },
        });

        Ok(action_from_bot_response(&resp, &legal, seat).or_else(|| fallback_action(&legal)))
    }

    fn view(&self) -> LocalGameView {
        LocalGameView {
            mode: self.mode,
            bot_4p: self.bot_4p.clone(),
            bot_3p: self.bot_3p.clone(),
            names: self.names.clone(),
            snapshot: self.engine.snapshot(),
            legal_actions: self
                .latest_human_actions
                .iter()
                .map(local_action_view)
                .collect(),
            message: self.message.clone(),
        }
    }
}

struct LocalSeatBot {
    seat: u8,
    name: String,
    runner: SubprocessBot,
    pending: Vec<MjaiEvent>,
}

enum LocalEngine {
    Four(GameState),
    Three(GameState3P),
}

impl LocalEngine {
    fn snapshot(&self) -> GameStateSnapshot {
        match self {
            Self::Four(s) => GameStateSnapshot::from_state(s, Some(HUMAN_SEAT)),
            Self::Three(s) => GameStateSnapshot::from_state_3p(s, Some(HUMAN_SEAT)),
        }
    }

    fn legal_actions(&self, seat: u8) -> Vec<Action> {
        match self {
            Self::Four(s) => s._get_legal_actions_internal(seat),
            Self::Three(s) => s._get_legal_actions_internal(seat),
        }
    }

    fn step(&mut self, actions: &HashMap<u8, Action>) {
        match self {
            Self::Four(s) => s.step(actions),
            Self::Three(s) => s.step(actions),
        }
    }

    fn logs_from(&self, start: usize) -> Vec<String> {
        match self {
            Self::Four(s) => s.mjai_log.iter().skip(start).cloned().collect(),
            Self::Three(s) => s.mjai_log.iter().skip(start).cloned().collect(),
        }
    }

    fn is_done(&self) -> bool {
        match self {
            Self::Four(s) => s.is_done,
            Self::Three(s) => s.is_done,
        }
    }

    fn needs_initialize_next_round(&self) -> bool {
        match self {
            Self::Four(s) => s.needs_initialize_next_round,
            Self::Three(s) => s.needs_initialize_next_round,
        }
    }

    fn phase(&self) -> Phase {
        match self {
            Self::Four(s) => s.phase,
            Self::Three(s) => s.phase,
        }
    }

    fn current_player(&self) -> u8 {
        match self {
            Self::Four(s) => s.current_player,
            Self::Three(s) => s.current_player,
        }
    }

    fn active_players(&self) -> Vec<u8> {
        match self {
            Self::Four(s) => s.active_players.clone(),
            Self::Three(s) => s.active_players.clone(),
        }
    }
}

async fn spawn_bot_for_seat(
    runtime: &PythonRuntime,
    entry: &BotEntry,
    seat: u8,
    syncs_in_flight: Arc<Mutex<HashSet<String>>>,
) -> Result<SubprocessBot> {
    if entry.pyproject.is_none() {
        bail!(
            "bot {} has no pyproject.toml; local opponents require a normal Akagi bot install",
            entry.name
        );
    }

    let _guard = SyncGuard::acquire(&syncs_in_flight, &entry.name)
        .await
        .ok_or_else(|| anyhow::anyhow!("sync already in progress for {}", entry.name))?;
    runtime.ensure_synced(&entry.dir).await?;
    drop(_guard);

    let mut cmd = runtime.command_for(&entry.dir, &["bot.py"]);
    cmd.arg(seat.to_string());
    if let Some(m) = entry.manifest.as_ref() {
        let values = manifest::load_values(&entry.dir, m)
            .with_context(|| format!("load settings for bot {}", entry.name))?;
        let path = manifest::write_resolved(&entry.dir, &values)
            .with_context(|| format!("write resolved settings for bot {}", entry.name))?;
        cmd.env("AKAGI_BOT_CONFIG", path);
    }
    SubprocessBot::spawn_with_command(cmd, runtime.clone(), &entry.dir, seat).await
}

fn choose_bot(requested: Option<String>, configured: &str, fallback: &str) -> String {
    requested
        .filter(|s| !s.trim().is_empty())
        .or_else(|| (!configured.trim().is_empty()).then(|| configured.to_string()))
        .unwrap_or_else(|| fallback.to_string())
}

fn action_id(action: &Action) -> String {
    let tile = action.tile.map(tid_to_mjai).unwrap_or_default();
    let consumed = action
        .consume_tiles
        .iter()
        .copied()
        .map(tid_to_mjai)
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{:?}|{}|{}|{}",
        action.action_type,
        action.actor.unwrap_or(255),
        tile,
        consumed
    )
}

fn local_action_view(action: &Action) -> LocalActionView {
    LocalActionView {
        id: action_id(action),
        kind: match action.action_type {
            ActionType::Discard => LocalActionKind::Discard,
            ActionType::Chi => LocalActionKind::Chi,
            ActionType::Pon => LocalActionKind::Pon,
            ActionType::Daiminkan => LocalActionKind::Daiminkan,
            ActionType::Ron => LocalActionKind::Ron,
            ActionType::Riichi => LocalActionKind::Riichi,
            ActionType::Tsumo => LocalActionKind::Tsumo,
            ActionType::Pass => LocalActionKind::Pass,
            ActionType::Ankan => LocalActionKind::Ankan,
            ActionType::Kakan => LocalActionKind::Kakan,
            ActionType::KyushuKyuhai => LocalActionKind::KyushuKyuhai,
            ActionType::Kita => LocalActionKind::Kita,
        },
        actor: action.actor.unwrap_or(HUMAN_SEAT),
        tile: action.tile.map(tid_to_mjai),
        consumed: action.consume_tiles.iter().copied().map(tid_to_mjai).collect(),
    }
}

fn fallback_action(legal: &[Action]) -> Option<Action> {
    for wanted in [
        ActionType::Pass,
        ActionType::Discard,
        ActionType::Riichi,
        ActionType::Kita,
        ActionType::Tsumo,
        ActionType::Ron,
        ActionType::KyushuKyuhai,
        ActionType::Ankan,
        ActionType::Kakan,
        ActionType::Daiminkan,
        ActionType::Pon,
        ActionType::Chi,
    ] {
        if let Some(action) = legal.iter().find(|a| a.action_type == wanted) {
            return Some(action.clone());
        }
    }
    legal.first().cloned()
}

fn action_from_bot_response(
    resp: &BotResponse,
    legal: &[Action],
    seat: u8,
) -> Option<Action> {
    let type_matches = |a: &Action, ty: ActionType| a.actor == Some(seat) && a.action_type == ty;
    match &resp.action {
        MjaiEvent::None => legal
            .iter()
            .find(|a| type_matches(a, ActionType::Pass))
            .cloned(),
        MjaiEvent::Dahai { actor, pai, .. } if *actor == seat => legal
            .iter()
            .find(|a| type_matches(a, ActionType::Discard) && action_tile_matches(a, pai))
            .cloned(),
        MjaiEvent::Reach { actor, .. } if *actor == seat => legal
            .iter()
            .find(|a| type_matches(a, ActionType::Riichi))
            .cloned(),
        MjaiEvent::Hora { actor, .. } if *actor == seat => legal
            .iter()
            .find(|a| type_matches(a, ActionType::Ron) || type_matches(a, ActionType::Tsumo))
            .cloned(),
        MjaiEvent::Ryukyoku { .. } => legal
            .iter()
            .find(|a| type_matches(a, ActionType::KyushuKyuhai))
            .cloned(),
        MjaiEvent::Kita { actor, pai } if *actor == seat => legal
            .iter()
            .find(|a| {
                type_matches(a, ActionType::Kita)
                    && pai.as_deref().map_or(true, |p| action_tile_matches(a, p))
            })
            .cloned(),
        MjaiEvent::Chi {
            actor,
            pai,
            consumed,
            ..
        } if *actor == seat => legal
            .iter()
            .find(|a| {
                type_matches(a, ActionType::Chi)
                    && action_tile_matches(a, pai)
                    && consumed_matches(a, consumed)
            })
            .cloned(),
        MjaiEvent::Pon {
            actor,
            pai,
            consumed,
            ..
        } if *actor == seat => legal
            .iter()
            .find(|a| {
                type_matches(a, ActionType::Pon)
                    && action_tile_matches(a, pai)
                    && consumed_matches(a, consumed)
            })
            .cloned(),
        MjaiEvent::Daiminkan {
            actor,
            pai,
            consumed,
            ..
        } if *actor == seat => legal
            .iter()
            .find(|a| {
                type_matches(a, ActionType::Daiminkan)
                    && action_tile_matches(a, pai)
                    && consumed_matches(a, consumed)
            })
            .cloned(),
        MjaiEvent::Ankan { actor, consumed } if *actor == seat => legal
            .iter()
            .find(|a| type_matches(a, ActionType::Ankan) && consumed_matches(a, consumed))
            .cloned(),
        MjaiEvent::Kakan {
            actor,
            pai,
            consumed,
        } if *actor == seat => legal
            .iter()
            .find(|a| {
                type_matches(a, ActionType::Kakan)
                    && action_tile_matches(a, pai)
                    && consumed_matches(a, consumed)
            })
            .cloned(),
        _ => None,
    }
}

fn action_tile_matches(action: &Action, pai: &str) -> bool {
    let Some(tile) = action.tile else {
        return false;
    };
    if tid_to_mjai(tile) == pai {
        return true;
    }
    mjai_to_tid(pai).is_some_and(|candidate| candidate / 4 == tile / 4)
}

fn consumed_matches<const N: usize>(action: &Action, consumed: &[String; N]) -> bool {
    let mut action_tiles: Vec<String> = action
        .consume_tiles
        .iter()
        .copied()
        .map(tid_to_mjai)
        .collect();
    let mut bot_tiles = consumed.to_vec();
    action_tiles.sort();
    bot_tiles.sort();
    if action_tiles == bot_tiles {
        return true;
    }

    let mut action_classes: Vec<u8> = action.consume_tiles.iter().map(|t| t / 4).collect();
    let mut bot_classes: Vec<u8> = consumed
        .iter()
        .filter_map(|p| mjai_to_tid(p).map(|t| t / 4))
        .collect();
    action_classes.sort();
    bot_classes.sort();
    action_classes == bot_classes
}

fn event_for_seat(event: &MjaiEvent, seat: u8) -> MjaiEvent {
    match event {
        MjaiEvent::StartGame {
            names,
            kyoku_first,
            aka_flag,
            num_players,
            ..
        } => MjaiEvent::StartGame {
            names: names.clone(),
            kyoku_first: *kyoku_first,
            aka_flag: *aka_flag,
            id: Some(seat),
            num_players: *num_players,
        },
        MjaiEvent::StartKyoku {
            bakaze,
            dora_marker,
            kyoku,
            honba,
            kyotaku,
            oya,
            scores,
            tehais,
            num_players,
        } => {
            let masked = tehais
                .iter()
                .enumerate()
                .map(|(idx, hand)| {
                    if idx == seat as usize {
                        hand.clone()
                    } else {
                        vec!["?".to_string(); hand.len()]
                    }
                })
                .collect();
            MjaiEvent::StartKyoku {
                bakaze: bakaze.clone(),
                dora_marker: dora_marker.clone(),
                kyoku: *kyoku,
                honba: *honba,
                kyotaku: *kyotaku,
                oya: *oya,
                scores: scores.clone(),
                tehais: masked,
                num_players: *num_players,
            }
        }
        MjaiEvent::Tsumo { actor, pai } if *actor != seat => MjaiEvent::Tsumo {
            actor: *actor,
            pai: "?".to_string(),
        },
        other => other.clone(),
    }
}
