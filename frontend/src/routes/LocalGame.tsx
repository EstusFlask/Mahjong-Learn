import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw, SquareArrowOutUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Mahgen } from '@/components/Mahgen'
import { HAS_TAURI, invoke } from '@/lib/tauri'
import { mjaiToMahgen } from '@/lib/tileIdx'
import type {
  AppConfig,
  BotInfo,
  LocalActionKind,
  LocalActionView,
  LocalGameMode,
  LocalGameView,
  PlayerSnapshot,
} from '@/types'

const MODES: Array<{ value: LocalGameMode; key: string; players: 3 | 4 }> = [
  { value: 'four_east', key: 'four_east', players: 4 },
  { value: 'four_hanchan', key: 'four_hanchan', players: 4 },
  { value: 'three_east', key: 'three_east', players: 3 },
  { value: 'three_hanchan', key: 'three_hanchan', players: 3 },
]

const ACTION_PRIORITY: LocalActionKind[] = [
  'tsumo',
  'ron',
  'riichi',
  'kita',
  'ankan',
  'kakan',
  'daiminkan',
  'pon',
  'chi',
  'kyushu_kyuhai',
  'pass',
]

export function LocalGame() {
  const { t } = useTranslation()
  const [bots, setBots] = useState<BotInfo[]>([])
  const [view, setView] = useState<LocalGameView | null>(null)
  const [mode, setMode] = useState<LocalGameMode>('four_east')
  const [bot4p, setBot4p] = useState('mortal')
  const [bot3p, setBot3p] = useState('mortal3p')
  const [busy, setBusy] = useState<'idle' | 'loading' | 'starting' | 'acting'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!HAS_TAURI) {
        setBusy('idle')
        return
      }
      try {
        const [config, installed, current] = await Promise.all([
          invoke<AppConfig>('get_config'),
          invoke<BotInfo[]>('list_bots'),
          invoke<LocalGameView | null>('get_local_game_state'),
        ])
        if (cancelled) return
        setBots(installed)
        setBot4p(config.bot.active_4p || 'mortal')
        setBot3p(config.bot.active_3p || 'mortal3p')
        if (current) {
          setView(current)
          setMode(current.mode)
          setBot4p(current.bot_4p)
          setBot3p(current.bot_3p)
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setBusy('idle')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const fourBots = useMemo(() => bots.filter((b) => supportsMode(b, '4p')), [bots])
  const threeBots = useMemo(() => bots.filter((b) => supportsMode(b, '3p')), [bots])
  const selectedPlayers = MODES.find((m) => m.value === mode)?.players ?? 4

  const start = async () => {
    setBusy('starting')
    setError(null)
    try {
      const next = await invoke<LocalGameView>('local_game_start', {
        req: {
          mode,
          bot_4p: bot4p,
          bot_3p: bot3p,
        },
      })
      setView(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('idle')
    }
  }

  const act = async (action: LocalActionView) => {
    setBusy('acting')
    setError(null)
    try {
      const next = await invoke<LocalGameView>('local_game_submit_action', {
        actionId: action.id,
      })
      setView(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('idle')
    }
  }

  const reset = async () => {
    setBusy('starting')
    setError(null)
    try {
      await invoke('local_game_stop')
      setView(null)
      await start()
    } catch (e) {
      setError(String(e))
      setBusy('idle')
    }
  }

  const openDetached = async () => {
    try {
      await invoke('open_local_game_window')
    } catch (e) {
      setError(String(e))
    }
  }

  const snapshot = view?.snapshot
  const actionGroups = useMemo(() => groupActions(view?.legal_actions ?? []), [view])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col gap-4 p-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t('local_game.title')}</h1>
            <p className="text-sm text-muted-foreground">
              {snapshot
                ? t('local_game.round_line', {
                    wind: snapshot.bakaze,
                    kyoku: snapshot.kyoku,
                    honba: snapshot.honba,
                    kyotaku: snapshot.kyotaku,
                  })
                : t('local_game.ready')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={mode} onValueChange={(v) => setMode(v as LocalGameMode)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {t(`local_game.modes.${m.key}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <BotSelect
              value={selectedPlayers === 3 ? bot3p : bot4p}
              bots={selectedPlayers === 3 ? threeBots : fourBots}
              fallback={selectedPlayers === 3 ? 'mortal3p' : 'mortal'}
              onChange={selectedPlayers === 3 ? setBot3p : setBot4p}
            />
            <Button onClick={start} disabled={busy !== 'idle'}>
              {busy === 'starting' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {view ? t('local_game.new_game') : t('local_game.start')}
            </Button>
            {view && (
              <Button variant="outline" size="icon" onClick={reset} disabled={busy !== 'idle'} aria-label={t('local_game.restart')}>
                <RotateCcw className="h-4 w-4" />
              </Button>
            )}
            <Button variant="outline" size="icon" onClick={openDetached} aria-label={t('local_game.open_window')}>
              <SquareArrowOutUpRight className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {view?.message && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {view.message}
          </div>
        )}

        <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[1fr_20rem]">
          <section className="grid min-h-[34rem] grid-cols-1 gap-3 rounded-md border bg-card/40 p-3 lg:grid-cols-3 lg:grid-rows-[auto_1fr_auto]">
            {snapshot ? (
              <Board players={snapshot.players} names={view.names} current={snapshot.current_player} />
            ) : (
              <div className="flex min-h-[32rem] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground lg:col-span-3">
                {busy === 'loading' ? t('common.loading') : t('local_game.no_game')}
              </div>
            )}
          </section>

          <aside className="grid content-start gap-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm uppercase tracking-wider">{t('local_game.dora')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Mahgen seq={mjaiToMahgen(snapshot?.dora_markers ?? [])} kind="dora" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm uppercase tracking-wider">{t('local_game.actions.title')}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {busy === 'acting' && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('local_game.thinking')}
                  </div>
                )}
                {ACTION_PRIORITY.map((kind) => {
                  const actions = actionGroups[kind] ?? []
                  if (!actions.length) return null
                  return (
                    <div key={kind} className="flex flex-wrap gap-2">
                      {actions.map((action) => (
                        <ActionButton
                          key={action.id}
                          action={action}
                          disabled={busy !== 'idle'}
                          onClick={() => void act(action)}
                        />
                      ))}
                    </div>
                  )
                })}
                {actionGroups.discard?.length ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(3.25rem,1fr))] gap-2">
                    {actionGroups.discard.map((action) => (
                      <ActionButton
                        key={action.id}
                        action={action}
                        disabled={busy !== 'idle'}
                        compact
                        onClick={() => void act(action)}
                      />
                    ))}
                  </div>
                ) : null}
                {!view?.legal_actions.length && (
                  <span className="text-sm text-muted-foreground">
                    {view?.snapshot.is_done ? t('local_game.ended') : t('local_game.waiting')}
                  </span>
                )}
              </CardContent>
            </Card>
          </aside>
        </main>
      </div>
    </div>
  )
}

function Board({
  players,
  names,
  current,
}: {
  players: PlayerSnapshot[]
  names: string[]
  current: number
}) {
  const order = players.length === 3 ? [1, 2, 0] : [2, 1, 3, 0]
  return (
    <>
      {order.map((seat, idx) => {
        const p = players[seat]
        if (!p) return null
        const area =
          players.length === 3
            ? idx === 0
              ? 'lg:col-start-1 lg:row-start-1'
              : idx === 1
                ? 'lg:col-start-3 lg:row-start-1'
                : 'lg:col-span-3 lg:row-start-3'
            : idx === 0
              ? 'lg:col-start-2 lg:row-start-1'
              : idx === 1
                ? 'lg:col-start-1 lg:row-start-2'
                : idx === 2
                  ? 'lg:col-start-3 lg:row-start-2'
                  : 'lg:col-span-3 lg:row-start-3'
        return (
          <SeatPanel
            key={seat}
            player={p}
            name={names[seat] ?? `P${seat + 1}`}
            isHuman={seat === 0}
            active={seat === current}
            className={area}
          />
        )
      })}
      <div className="hidden items-center justify-center rounded-md border border-border/70 bg-background/60 text-xs text-muted-foreground lg:col-start-2 lg:row-start-2 lg:flex">
        Akagi
      </div>
    </>
  )
}

function SeatPanel({
  player,
  name,
  isHuman,
  active,
  className,
}: {
  player: PlayerSnapshot
  name: string
  isHuman: boolean
  active: boolean
  className?: string
}) {
  const hand = isHuman ? player.tehai : Array.from({ length: player.tehai.length }, () => '?')
  const river = player.river.map((r) => r.tile)
  return (
    <div className={`grid min-h-[11rem] content-start gap-2 rounded-md border p-3 ${active ? 'border-primary/80 bg-primary/5' : 'border-border bg-background/70'} ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="font-mono text-xs text-muted-foreground">{player.score.toLocaleString()}</div>
        </div>
        <div className="flex items-center gap-1 text-[0.68rem] uppercase text-muted-foreground">
          {player.riichi_declared && <span>Riichi</span>}
          {player.kita_tiles.length > 0 && <span>Kita {player.kita_tiles.length}</span>}
        </div>
      </div>
      <div className="min-h-8 overflow-hidden">
        <Mahgen seq={mjaiToMahgen(river)} kind="river" riverMode />
      </div>
      <div className="flex flex-wrap gap-1">
        {player.melds.map((m, idx) => (
          <Mahgen key={`${m.kind}-${idx}`} seq={mjaiToMahgen(m.tiles)} kind="melds" />
        ))}
      </div>
      <div className="min-h-8 overflow-hidden">
        <Mahgen seq={mjaiToMahgen(hand)} kind="hand" />
      </div>
    </div>
  )
}

function BotSelect({
  value,
  bots,
  fallback,
  onChange,
}: {
  value: string
  bots: BotInfo[]
  fallback: string
  onChange: (value: string) => void
}) {
  const options = bots.length ? bots : [{ name: fallback } as BotInfo]
  return (
    <Select value={value || fallback} onValueChange={onChange}>
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((bot) => (
          <SelectItem key={bot.name} value={bot.name}>
            {bot.manifest?.bot.display || bot.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ActionButton({
  action,
  disabled,
  compact,
  onClick,
}: {
  action: LocalActionView
  disabled: boolean
  compact?: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  const tileSeq = action.tile ? mjaiToMahgen([action.tile]) : ''
  return (
    <Button
      variant={action.kind === 'pass' ? 'outline' : 'secondary'}
      size={compact ? 'sm' : 'default'}
      className={compact ? 'h-11 justify-center px-2' : 'min-w-20'}
      onClick={onClick}
      disabled={disabled}
    >
      {tileSeq ? <Mahgen seq={tileSeq} kind="bot-action" className="mr-1" /> : null}
      {!compact && t(`local_game.actions.${action.kind}`)}
    </Button>
  )
}

function groupActions(actions: LocalActionView[]): Record<LocalActionKind, LocalActionView[]> {
  return actions.reduce((acc, action) => {
    ;(acc[action.kind] ??= []).push(action)
    return acc
  }, {} as Record<LocalActionKind, LocalActionView[]>)
}

function supportsMode(bot: BotInfo, mode: '3p' | '4p'): boolean {
  const supported = bot.manifest?.bot.supported_modes
  return !supported?.length || supported.includes(mode)
}
