import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Toaster } from '@/components/ui/sonner'
import { invoke } from '@/lib/tauri'
import { useTauriBridge } from '@/hooks/useTauriBridge'
import { useConfigStore } from '@/stores/configStore'
import { ManifestField } from '@/components/ManifestField'
import { GithubMark, DiscordMark } from '@/components/BrandMarks'
import { AKAGI_GITHUB_URL, AKAGI_DISCORD_URL, openExternal } from '@/lib/external'
import { PLATFORMS, platformInfo } from '@/lib/platforms'
import { LANG_LABELS, SUPPORTED_LANGS, type SupportedLang } from '@/i18n'
import type { AppConfig, BotInfo, BotSettings, DetectedBrowser, PlatformKind } from '@/types'

type Step = 'welcome' | 'platform' | 'mode' | 'config' | 'bots' | 'configure' | 'finish'

const STEPS: Step[] = ['welcome', 'platform', 'mode', 'config', 'bots', 'configure', 'finish']
const LOCAL_STEPS: Step[] = ['welcome', 'platform', 'bots', 'configure', 'finish']

// Author-provided MJAI bots installed by the first-run wizard. Same
// install path as the manual Bots → Install From GitHub flow, just
// pre-filled with author defaults.
const BOT_REPO = 'shinkuan/Akagi-MjaiBot-Mortal'
const BOT_4P_NAME = 'mortal'
const BOT_3P_NAME = 'mortal3p'
const BOT_4P_ASSET = 'release4p.zip'
const BOT_3P_ASSET = 'release3p.zip'

export function Setup() {
  const { t } = useTranslation()
  // The wizard renders standalone (no <App> parent), so we wire the
  // tauri event bridge + toast surface here ourselves. Without this the
  // CfT download progress notifications wouldn't show up during setup.
  useTauriBridge()
  const stored = useConfigStore((s) => s.config)
  const setStored = useConfigStore((s) => s.setConfig)
  const [draft, setDraft] = useState<AppConfig | null>(stored)
  const [step, setStep] = useState<Step>('welcome')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [params] = useSearchParams()
  const navigate = useNavigate()
  // Bot settings drafts keyed by bot name. Populated lazily when the
  // configure step mounts (ConfigureBotsStep loads via get_bot_settings).
  // Lifted here so `next()` can flush them to disk before advancing.
  // MUST live above the early-return below — React forbids skipping a
  // hook on first render and then calling it on subsequent renders.
  const [botSettingsDraft, setBotSettingsDraft] = useState<Record<string, BotSettings>>({})

  // True when the user is re-running setup from Settings (not first run).
  const isRerun = params.get('rerun') === '1' || stored?.general.first_run_completed === true

  useEffect(() => {
    if (stored) setDraft(stored)
  }, [stored])

  useEffect(() => {
    if (!stored) {
      invoke<AppConfig>('get_config').then(setStored).catch(() => {})
    }
  }, [stored, setStored])

  if (!draft) {
    return <div className="p-6 text-muted-foreground">{t('setup.loading')}</div>
  }

  const activeSteps = draft.platform.kind === 'Local' ? LOCAL_STEPS : STEPS
  const idx = Math.max(0, activeSteps.indexOf(step))
  const canBack = idx > 0
  const canNext = idx < activeSteps.length - 1

  const saveBotSettings = async () => {
    for (const [name, settings] of Object.entries(botSettingsDraft)) {
      try {
        await invoke('update_bot_settings', { name, values: settings.values })
      } catch (e) {
        // Surface the first failure to the wizard's error strip; let
        // the user retry. Don't proceed to Finish with stale settings.
        throw new Error(`Save failed for ${name}: ${e}`)
      }
    }
  }

  const next = async () => {
    if (step === 'configure') {
      setBusy(true)
      setErr(null)
      try {
        await saveBotSettings()
      } catch (e) {
        setErr(String(e))
        setBusy(false)
        return
      }
      setBusy(false)
    }
    setStep(activeSteps[idx + 1])
  }
  const back = () => setStep(activeSteps[idx - 1])

  const finish = async () => {
    setBusy(true)
    setErr(null)
    try {
      // Re-query the bot list so the chosen active_4p / active_3p
      // reflect what's *actually* installed right now, regardless of
      // whether the user installed in this wizard run or already had
      // bots from a previous install.
      let installed: BotInfo[] = []
      try {
        installed = await invoke<BotInfo[]>('list_bots')
      } catch {
        /* ignore: bot dir may not be set up — we'll just leave the
           active_* fields at whatever the user had before. */
      }
      const has4p = installed.some((b) => b.name === BOT_4P_NAME)
      const has3p = installed.some((b) => b.name === BOT_3P_NAME)

      const final: AppConfig = {
        ...draft,
        general: { ...draft.general, first_run_completed: true },
        bot: {
          ...draft.bot,
          // Auto-enable + select author bots when the wizard installed
          // them. Don't downgrade an existing custom config (e.g. user
          // re-runs setup but keeps their own bot.active_4p): only
          // touch active_* when the corresponding bot is present.
          enabled: draft.bot.enabled || has4p || has3p,
          active_4p: has4p ? BOT_4P_NAME : draft.bot.active_4p,
          active_3p: has3p ? BOT_3P_NAME : draft.bot.active_3p,
        },
      }
      await invoke('update_config', { newConfig: final })
      setStored(final)
      if (final.platform.kind === 'Local') {
        await invoke('open_local_game_window').catch(() => {})
      }
      navigate('/', { replace: true })
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => navigate('/', { replace: true })

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-6">
      <Toaster />
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t('setup.title')}</CardTitle>
            <span className="text-xs text-muted-foreground">
              {t('setup.step_progress', { current: idx + 1, total: activeSteps.length })}
            </span>
          </div>
          <Stepper current={idx} steps={activeSteps} />
        </CardHeader>
        <CardContent className="grid gap-6">
          {step === 'welcome' && <WelcomeStep />}
          {step === 'platform' && <PlatformStep draft={draft} setDraft={setDraft} />}
          {step === 'mode' && <ModeStep draft={draft} setDraft={setDraft} />}
          {step === 'config' && <ConfigStep draft={draft} setDraft={setDraft} />}
          {step === 'bots' && <BotsStep />}
          {step === 'configure' && (
            <ConfigureBotsStep
              drafts={botSettingsDraft}
              setDrafts={setBotSettingsDraft}
            />
          )}
          {step === 'finish' && <FinishStep draft={draft} />}

          {err && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {err}
            </div>
          )}

          <div className="flex justify-between">
            <div className="flex gap-2">
              {canBack ? (
                <Button variant="outline" onClick={back} disabled={busy}>{t('common.back')}</Button>
              ) : (
                <span />
              )}
              {isRerun && (
                <Button variant="ghost" onClick={cancel} disabled={busy}>{t('common.cancel')}</Button>
              )}
            </div>
            {canNext ? (
              <Button onClick={next} disabled={busy}>{t('common.next')}</Button>
            ) : (
              <Button onClick={finish} disabled={busy}>
                {busy ? t('common.saving') : t('common.finish')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function Stepper({ current, steps }: { current: number; steps: Step[] }) {
  return (
    <div className="flex gap-1.5 mt-3">
      {steps.map((_, i) => (
        <div
          key={i}
          className={`h-1 flex-1 rounded ${i <= current ? 'bg-primary' : 'bg-muted'}`}
        />
      ))}
    </div>
  )
}

function PlatformStep({
  draft,
  setDraft,
}: {
  draft: AppConfig
  setDraft: (c: AppConfig) => void
}) {
  const { t } = useTranslation()
  const current = draft.platform.kind
  // Switching platforms inside the first-run wizard always rewrites
  // chromium.start_url to the new platform's default — a user that's
  // walking through the wizard hasn't had a chance to customise yet,
  // and an old default left over from a previous platform pick is
  // strictly wrong (it would land the launched browser on the wrong
  // game). Re-customisation, if needed, happens on the Chromium config
  // step that comes next.
  const pick = (kind: PlatformKind) => {
    if (kind === current) return
    setDraft({
      ...draft,
      platform: { kind },
      capture: {
        ...draft.capture,
        chromium: {
          ...draft.capture.chromium,
          start_url: platformInfo(kind).defaultStartUrl,
        },
      },
    })
  }

  return (
    <div className="grid gap-3">
      <h2 className="text-lg font-semibold">{t('setup.platform.title')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('setup.platform.desc')}
      </p>
      {PLATFORMS.map((p) => (
        <ModeCard
          key={p.kind}
          title={t(p.labelKey)}
          active={current === p.kind}
          onClick={() => pick(p.kind)}
          description={t(p.descriptionKey)}
        />
      ))}
    </div>
  )
}

function WelcomeStep() {
  const { t, i18n } = useTranslation()
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        {/* Trilingual label so a user who can't read English/JP/CN still
            recognises this as a language picker before changing it. */}
        <Label className="text-xs">{t('setup.lang_label')}</Label>
        <Select
          value={i18n.language}
          onValueChange={(v) => void i18n.changeLanguage(v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_LANGS.map((lang) => (
              <SelectItem key={lang} value={lang}>
                {LANG_LABELS[lang as SupportedLang]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <h2 className="text-lg font-semibold mt-2">{t('setup.welcome.title')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('setup.welcome.body1')}
      </p>
      <p className="text-sm text-muted-foreground">
        {t('setup.welcome.body2')}
      </p>

      {/* Official project links — surfaced early so a fresh user can
          find the canonical repo / community before going any further.
          Intentionally low-key (no banner / colour) since these are
          informational, not warnings. */}
      <div className="flex flex-wrap items-center gap-2 mt-1">
        <span className="text-xs text-muted-foreground mr-1">
          {t('setup.welcome.links_label')}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openExternal(AKAGI_GITHUB_URL)}
        >
          <GithubMark className="h-4 w-4 mr-1.5" />
          GitHub
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openExternal(AKAGI_DISCORD_URL)}
        >
          <DiscordMark className="h-4 w-4 mr-1.5" />
          Discord
        </Button>
      </div>
    </div>
  )
}

function ModeStep({
  draft,
  setDraft,
}: {
  draft: AppConfig
  setDraft: (c: AppConfig) => void
}) {
  const { t } = useTranslation()
  const mode = draft.capture.mode
  return (
    <div className="grid gap-3">
      <h2 className="text-lg font-semibold">{t('setup.mode.title')}</h2>
      <ModeCard
        title={t('setup.mode.chromium_title')}
        active={mode === 'chromium'}
        onClick={() => setDraft({ ...draft, capture: { ...draft.capture, mode: 'chromium' } })}
        description={t('setup.mode.chromium_desc')}
      />
      <ModeCard
        title={t('setup.mode.mitm_title')}
        active={mode === 'mitm'}
        onClick={() => setDraft({ ...draft, capture: { ...draft.capture, mode: 'mitm' } })}
        description={t('setup.mode.mitm_desc')}
      />
    </div>
  )
}

function ModeCard({
  title,
  description,
  active,
  onClick,
}: {
  title: string
  description: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-md border p-4 transition-colors ${
        active ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-3 w-3 rounded-full border-2 ${
            active ? 'border-primary bg-primary' : 'border-muted-foreground/40'
          }`}
        />
        <span className="font-medium">{title}</span>
      </div>
      <p className="text-sm text-muted-foreground mt-2">{description}</p>
    </button>
  )
}

function ConfigStep({
  draft,
  setDraft,
}: {
  draft: AppConfig
  setDraft: (c: AppConfig) => void
}) {
  const { t } = useTranslation()
  if (draft.capture.mode === 'mitm') {
    return (
      <div className="grid gap-3">
        <h2 className="text-lg font-semibold">{t('setup.mitm.title')}</h2>
        <Field label={t('setup.mitm.listen')}>
          <Input
            value={draft.proxy.addr}
            onChange={(e) => setDraft({ ...draft, proxy: { ...draft.proxy, addr: e.target.value } })}
            placeholder="127.0.0.1:23410"
          />
        </Field>
        <Field
          label={t('settings.ca_dir')}
          hint={t('setup.mitm.ca_dir_hint')}
        >
          <Input
            value={draft.proxy.ca_dir}
            onChange={(e) => setDraft({ ...draft, proxy: { ...draft.proxy, ca_dir: e.target.value } })}
          />
        </Field>
        <Field label={t('settings.proxy_enabled')} hint={t('setup.mitm.proxy_enabled_hint')}>
          <Select
            value={draft.proxy.enabled ? 'on' : 'off'}
            onValueChange={(v) => setDraft({ ...draft, proxy: { ...draft.proxy, enabled: v === 'on' } })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="on">{t('common.on')}</SelectItem>
              <SelectItem value="off">{t('common.off')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
    )
  }
  return <ChromiumConfigStep draft={draft} setDraft={setDraft} />
}

function ChromiumConfigStep({
  draft,
  setDraft,
}: {
  draft: AppConfig
  setDraft: (c: AppConfig) => void
}) {
  const { t } = useTranslation()
  const chromium = draft.capture.chromium
  const setChromium = (patch: Partial<typeof chromium>) =>
    setDraft({
      ...draft,
      capture: { ...draft.capture, chromium: { ...chromium, ...patch } },
    })

  const [detected, setDetected] = useState<DetectedBrowser[] | null>(null)
  const [installed, setInstalled] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<'idle' | 'detecting' | 'downloading'>('idle')

  const refresh = async () => {
    setBusy('detecting')
    try {
      const [d, i] = await Promise.all([
        invoke<DetectedBrowser[]>('detect_system_chrome'),
        invoke<string[]>('list_cft_installed'),
      ])
      setDetected(d)
      setInstalled(i)
    } catch {
      setDetected([])
      setInstalled([])
    } finally {
      setBusy('idle')
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const downloadCft = async () => {
    setBusy('downloading')
    try {
      await invoke<string>('download_chrome_for_testing', {
        channel: chromium.cft_channel || 'stable',
      })
      // Explicit download in the wizard = explicit opt-in to CfT.
      // Without this, a user who has both system Chrome and a freshly
      // downloaded CfT would still launch the system Chrome (system
      // takes priority unless force_cft is on), which is exactly what
      // the "Download" button was meant to override.
      setChromium({ force_cft: true })
      await refresh()
    } catch {
      /* surfaced via notify */
    } finally {
      setBusy('idle')
    }
  }

  const ready = (detected && detected.length > 0) || (installed && installed.length > 0) || chromium.executable

  return (
    <div className="grid gap-3">
      <h2 className="text-lg font-semibold">{t('setup.chromium.title')}</h2>
      <Field label={t('settings.browser_executable')} hint={t('setup.chromium.exec_hint')}>
        <Input
          value={chromium.executable}
          onChange={(e) => setChromium({ executable: e.target.value })}
          placeholder={t('common.auto_detect')}
        />
      </Field>
      <div className="rounded-md border border-border/50 p-3 grid gap-2">
        <div className="flex items-center justify-between">
          <Label>{t('setup.chromium.detected_label')}</Label>
          <Button variant="outline" size="sm" onClick={refresh} disabled={busy !== 'idle'}>
            {busy === 'detecting' ? t('common.scanning') : t('common.refresh')}
          </Button>
        </div>
        {detected === null ? (
          <span className="text-xs text-muted-foreground">{t('common.scanning')}</span>
        ) : detected.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t('setup.chromium.no_browser')}</span>
        ) : (
          <ul className="text-xs font-mono break-all">
            {detected.map((d) => (
              <li key={d.path}>· {d.path}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="rounded-md border border-border/50 p-3 grid gap-2">
        <div className="flex items-center justify-between">
          <Label>{t('settings.cft_title')}</Label>
          <span className="text-xs text-muted-foreground">
            {installed === null
              ? t('settings.cft_status_loading')
              : installed.length === 0
                ? t('settings.cft_status_none')
                : t('settings.cft_status_count', { count: installed.length })}
          </span>
        </div>
        <Field label={t('settings.cft_channel')} hint={t('settings.cft_channel_hint')}>
          <Input
            value={chromium.cft_channel}
            onChange={(e) => setChromium({ cft_channel: e.target.value })}
            placeholder="stable"
          />
        </Field>
        <Button onClick={downloadCft} disabled={busy !== 'idle'} size="sm">
          {busy === 'downloading' ? t('common.downloading') : t('common.download')}
        </Button>
      </div>
      <Field
        label={t('settings.start_url')}
        hint={t('settings.start_url_hint', {
          platform: t(platformInfo(draft.platform.kind).labelKey),
          url: platformInfo(draft.platform.kind).defaultStartUrl,
        })}
      >
        <Input
          value={chromium.start_url}
          onChange={(e) => setChromium({ start_url: e.target.value })}
          placeholder={platformInfo(draft.platform.kind).defaultStartUrl}
        />
      </Field>
      {!ready && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {t('setup.chromium.warning_no_browser')}
        </div>
      )}
    </div>
  )
}

function BotsStep() {
  const { t } = useTranslation()
  const [installed, setInstalled] = useState<BotInfo[] | null>(null)
  const [installing, setInstalling] = useState<'4p' | '3p' | null>(null)
  const [errors, setErrors] = useState<{ [k: string]: string }>({})

  const refresh = async () => {
    try {
      const list = await invoke<BotInfo[]>('list_bots')
      setInstalled(list)
    } catch {
      setInstalled([])
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const has4p = installed?.some((b) => b.name === BOT_4P_NAME) ?? false
  const has3p = installed?.some((b) => b.name === BOT_3P_NAME) ?? false

  const install = async (mode: '4p' | '3p') => {
    setInstalling(mode)
    setErrors((e) => {
      const { [mode]: _, ...rest } = e
      return rest
    })
    try {
      await invoke('install_bot_from_github', {
        repo: BOT_REPO,
        assetGlob: mode === '4p' ? BOT_4P_ASSET : BOT_3P_ASSET,
        name: mode === '4p' ? BOT_4P_NAME : BOT_3P_NAME,
      })
      await refresh()
    } catch (e) {
      setErrors((prev) => ({ ...prev, [mode]: String(e) }))
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div className="grid gap-3">
      <h2 className="text-lg font-semibold">{t('setup.bots.title')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('setup.bots.desc')}
      </p>
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        <b>{t('setup.bots.license_label')}</b>{' '}
        {t('setup.bots.license_body', { license: 'AGPL-3.0' })}
      </div>
      <BotInstallCard
        title={t('setup.bots.yonma_title')}
        description={t('setup.bots.yonma_desc')}
        installed={has4p}
        installing={installing === '4p'}
        disabled={installing !== null}
        error={errors['4p']}
        onInstall={() => install('4p')}
      />
      <BotInstallCard
        title={t('setup.bots.sanma_title')}
        description={t('setup.bots.sanma_desc')}
        installed={has3p}
        installing={installing === '3p'}
        disabled={installing !== null}
        error={errors['3p']}
        onInstall={() => install('3p')}
      />
      <p className="text-xs text-muted-foreground">
        {t('setup.bots.install_note', { cmd: 'uv sync', file: 'pyproject.toml' })}
      </p>
    </div>
  )
}

function BotInstallCard({
  title,
  description,
  installed,
  installing,
  disabled,
  error,
  onInstall,
}: {
  title: string
  description: string
  installed: boolean
  installing: boolean
  disabled: boolean
  error?: string
  onInstall: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border p-3 grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        {installed ? (
          <span className="text-xs px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            {t('common.installed')}
          </span>
        ) : (
          <Button onClick={onInstall} disabled={disabled} size="sm">
            {installing ? t('common.installing') : t('common.install')}
          </Button>
        )}
      </div>
      {error && (
        <div className="text-xs text-red-400 font-mono break-all">{error}</div>
      )}
    </div>
  )
}

function ConfigureBotsStep({
  drafts,
  setDrafts,
}: {
  drafts: Record<string, BotSettings>
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, BotSettings>>>
}) {
  const { t } = useTranslation()
  const [installed, setInstalled] = useState<BotInfo[] | null>(null)
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})

  // Pull the bot list, then for each bot with a manifest fetch its
  // current values into the wizard draft. Skip bots that already have a
  // draft so back-and-forth navigation doesn't clobber unsaved edits.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let list: BotInfo[]
      try {
        list = await invoke<BotInfo[]>('list_bots')
      } catch {
        if (!cancelled) setInstalled([])
        return
      }
      if (cancelled) return
      setInstalled(list)
      const targets = list.filter(
        (b) => (b.name === BOT_4P_NAME || b.name === BOT_3P_NAME) && b.manifest,
      )
      for (const b of targets) {
        if (drafts[b.name]) continue
        try {
          const s = await invoke<BotSettings>('get_bot_settings', { name: b.name })
          if (cancelled) return
          setDrafts((prev) => ({ ...prev, [b.name]: s }))
        } catch (e) {
          if (cancelled) return
          setLoadErrors((prev) => ({ ...prev, [b.name]: String(e) }))
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const wizardBots = (installed ?? []).filter(
    (b) => b.name === BOT_4P_NAME || b.name === BOT_3P_NAME,
  )

  if (installed === null) {
    return <div className="text-sm text-muted-foreground">{t('setup.configure.loading')}</div>
  }

  if (wizardBots.length === 0) {
    return (
      <div className="grid gap-3">
        <h2 className="text-lg font-semibold">{t('setup.configure.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('setup.configure.empty_desc')}
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      <h2 className="text-lg font-semibold">{t('setup.configure.title')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('setup.configure.normal_desc')}
      </p>

      {/* The Mortal weights bundled in the GitHub release are a
          placeholder forced by GitHub's file-size limit — they prove
          the install works but aren't strong enough for real play.
          Point users at Discord for the real weights (paid hosted API
          + free local models both live there) before they walk away
          unimpressed by the placeholder's playstyle. */}
      <div className="rounded-md border border-indigo-500/40 bg-indigo-500/10 p-3 grid gap-2">
        <div className="flex items-center gap-2 text-indigo-200 font-semibold text-sm">
          <DiscordMark className="h-4 w-4" />
          {t('setup.configure.models_title')}
        </div>
        <p className="text-sm text-indigo-100/90">
          {t('setup.configure.models_body')}
        </p>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openExternal(AKAGI_DISCORD_URL)}
          >
            <DiscordMark className="h-4 w-4 mr-1.5" />
            {t('setup.configure.models_btn')}
          </Button>
        </div>
      </div>
      {wizardBots.map((b) => (
        <BotSettingsForm
          key={b.name}
          name={b.name}
          loadError={loadErrors[b.name]}
          settings={drafts[b.name]}
          onChange={(values) =>
            setDrafts((prev) => {
              const cur = prev[b.name]
              if (!cur) return prev
              return { ...prev, [b.name]: { ...cur, values } }
            })
          }
        />
      ))}
    </div>
  )
}

function BotSettingsForm({
  name,
  settings,
  loadError,
  onChange,
}: {
  name: string
  settings: BotSettings | undefined
  loadError?: string
  onChange: (values: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const title = settings?.manifest.bot.display ?? name
  const description = settings?.manifest.bot.description

  if (loadError) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-red-400 font-mono break-all mt-1">{loadError}</div>
      </div>
    )
  }
  if (!settings) {
    return (
      <div className="rounded-md border p-3 text-sm text-muted-foreground">
        {t('setup.configure.loading_bot', { name })}
      </div>
    )
  }

  const entries = Object.entries(settings.manifest.settings)
  return (
    <div className="rounded-md border p-3 grid gap-3">
      <div>
        <div className="font-medium">{title}</div>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
      {entries.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('setup.configure.no_settings')}</div>
      ) : (
        <div className="grid gap-3">
          {entries.map(([key, spec]) => (
            <ManifestField
              key={key}
              fieldKey={key}
              spec={spec}
              value={settings.values[key] ?? spec.default}
              onChange={(v) => onChange({ ...settings.values, [key]: v })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FinishStep({ draft }: { draft: AppConfig }) {
  const { t } = useTranslation()
  const m = draft.capture.mode
  const isLocal = draft.platform.kind === 'Local'
  const [installed, setInstalled] = useState<BotInfo[] | null>(null)
  useEffect(() => {
    invoke<BotInfo[]>('list_bots').then(setInstalled).catch(() => setInstalled([]))
  }, [])
  const has4p = installed?.some((b) => b.name === BOT_4P_NAME) ?? false
  const has3p = installed?.some((b) => b.name === BOT_3P_NAME) ?? false
  const botSummary = has4p && has3p
    ? `${BOT_4P_NAME} (4P), ${BOT_3P_NAME} (3P)`
    : has4p
      ? `${BOT_4P_NAME} (4P)`
      : has3p
        ? `${BOT_3P_NAME} (3P)`
        : t('setup.finish.bots_none')
  return (
    <div className="grid gap-3">
      <h2 className="text-lg font-semibold">{t('setup.finish.title')}</h2>
      <div className="rounded-md border border-border/50 p-3 text-sm">
        <div><b>{t('setup.finish.platform_label')}</b> {t(platformInfo(draft.platform.kind).labelKey)}</div>
        {isLocal ? (
          <div><b>{t('setup.finish.mode_label')}</b> {t('setup.finish.mode_local')}</div>
        ) : (
          <div><b>{t('setup.finish.mode_label')}</b> {m === 'chromium' ? t('setup.finish.mode_chromium') : t('setup.finish.mode_mitm')}</div>
        )}
        {!isLocal && m === 'mitm' && (
          <>
            <div><b>{t('setup.finish.listen_label')}</b> {draft.proxy.addr}</div>
            <div><b>{t('setup.finish.ca_dir_label')}</b> {draft.proxy.ca_dir}</div>
          </>
        )}
        {!isLocal && m === 'chromium' && (
          <>
            <div>
              <b>{t('setup.finish.exec_label')}</b>{' '}
              {draft.capture.chromium.executable
                ? draft.capture.chromium.executable
                : draft.capture.chromium.force_cft
                  ? t('setup.finish.exec_cft', { channel: draft.capture.chromium.cft_channel || 'stable' })
                  : t('setup.finish.exec_autodetect')}
            </div>
            <div><b>{t('setup.finish.start_url_label')}</b> {draft.capture.chromium.start_url}</div>
            <div><b>{t('setup.finish.cft_channel_label')}</b> {draft.capture.chromium.cft_channel}</div>
          </>
        )}
        <div><b>{t('setup.finish.bots_label')}</b> {installed === null ? t('setup.finish.bots_checking') : botSummary}</div>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('setup.finish.click_finish_pre')}<b>{t('setup.finish.click_finish_btn')}</b>
        {isLocal ? ' to save these settings and open the local table.' : t('setup.finish.click_finish_post')}
      </p>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}
