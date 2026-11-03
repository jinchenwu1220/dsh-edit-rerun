/**
 * dsh-edit-rerun — browser half.
 *
 * Adds one compact control to the composer's right tool row
 * (`conversation.input.right`). It lists every real user prompt of the open
 * Session — read from the Host route `/dsh-edit-rerun/turns`, which parses the
 * Session log — and lets you edit one of them, then re-runs it:
 *
 * - fork at the `turn/end` that closed the turn *before* the chosen prompt, so
 *   the child inherits exactly the history that preceded it;
 * - the edited text is written into the **child's** composer draft, so you can
 *   keep editing and submit yourself. Nothing is auto-sent.
 *
 * The source Session is never modified: the Session log is append-only, so
 * "edit history" is expressed as "branch and re-run". The first prompt of a
 * Session has nothing to inherit and starts a fresh Session in the same
 * workspace instead.
 *
 * All DOM/runtime failures are logged, never thrown: a throwing plugin blanks
 * its slot entry and the Web shell fails the whole boot when `apply` throws.
 *
 * @module dsh-edit-rerun/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-edit-rerun',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace of this package. */
    const NS = 'dsh-edit-rerun'

    /** Where the pending draft of a freshly forked child is parked. */
    const PENDING_KEY = 'dsh-edit-rerun:pending-draft'

    /** Composer colours, all host theme tokens so light/dark both work. */
    const theme = {
      panel: 'var(--dsw-alias-bg-module-platform)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-tertiary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      accent: 'var(--dsw-alias-state-business-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      shadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
    }

    /**
     * Read the parked draft.
     * @returns `{sessionId, text}` or null; never throws.
     */
    function readPending() {
      try {
        const raw = localStorage.getItem(PENDING_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        if (typeof parsed.sessionId !== 'string' || typeof parsed.text !== 'string') return null
        return parsed
      } catch {
        return null
      }
    }

    /** Park or clear the pending draft; never throws. */
    function writePending(value) {
      try {
        if (value === null) localStorage.removeItem(PENDING_KEY)
        else localStorage.setItem(PENDING_KEY, JSON.stringify(value))
      } catch {
        /* storage unavailable — the draft simply will not carry over */
      }
    }

    /** First line of a prompt, trimmed for a one-line row. */
    function previewOf(text) {
      const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? text
      return firstLine.trim()
    }

    /** The loop-arrow glyph; inherits `currentColor`. */
    function RerunGlyph(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: props.size ?? 15,
          height: props.size ?? 15,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M3.2 8a4.8 4.8 0 1 1 1.6 3.6' }),
        h('path', { d: 'M2.4 4.6v3.2h3.2' }),
      )
    }

    /** One shared host-token button. */
    function makeButtonStyle(tone) {
      return {
        height: 28,
        padding: '0 12px',
        borderRadius: 7,
        border: tone === 'primary' ? '1px solid transparent' : `1px solid ${theme.border}`,
        background: tone === 'primary' ? theme.accent : 'transparent',
        color: tone === 'primary' ? '#fff' : theme.text,
        fontSize: 12.5,
        lineHeight: '26px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }
    }

    /**
     * Render the seat.
     * @param props - framework standard props of `conversation.input.right`.
     */
    function makeSeat(ctx, t) {
      return function RerunSeat(props) {
        const sessionId = props?.sessionId ?? props?.session?.sessionId
        const inputActions = props?.inputActions
        const useInput = props?.useInput
        // The composer's current draft. Used only to hand a parked prompt to a
        // freshly forked Session once its editor is actually empty and ready.
        const draft = typeof useInput === 'function'
          ? useInput((state) => (typeof state?.draft === 'string' ? state.draft : undefined))
          : undefined

        const [open, setOpen] = React.useState(false)
        const [loading, setLoading] = React.useState(false)
        const [error, setError] = React.useState('')
        const [turns, setTurns] = React.useState(null)
        const [selected, setSelected] = React.useState(null)
        const [text, setText] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [anchor, setAnchor] = React.useState({ bottom: 96, right: 24 })
        const buttonRef = React.useRef(null)

        // Hand the parked draft to the child Session's composer.
        //
        // Retried on every publish instead of after a fixed delay, and only
        // while the editor is still empty: the composer of a just-opened fork
        // may not exist yet at the first render, and overwriting text the user
        // already typed is worse than never applying it. The 8 s window keeps a
        // stale record from firing in some later Session.
        // Keyed by Session, not a boolean: the composer seat survives session
        // navigation, so a boolean would refuse the second fork of one page.
        const appliedRef = React.useRef(null)
        React.useEffect(() => {
          if (appliedRef.current === sessionId) return
          if (typeof sessionId !== 'string') return
          if (draft !== undefined && draft !== '') return
          const pending = readPending()
          if (pending === null || pending.sessionId !== sessionId) return
          if (Date.now() - (pending.at ?? 0) > 8000) {
            writePending(null)
            return
          }
          try {
            if (inputActions === undefined || typeof inputActions.setDraft !== 'function') return
            appliedRef.current = sessionId
            inputActions.setDraft(pending.text)
            writePending(null)
          } catch (cause) {
            console.error('[dsh-edit-rerun] setDraft failed:', cause)
          }
        }, [sessionId, draft, inputActions])

        const close = React.useCallback(() => {
          setOpen(false)
          setSelected(null)
          setText('')
          setError('')
        }, [])

        // Escape closes the panel, like a host popover.
        React.useEffect(() => {
          if (!open) return undefined
          const onKeyDown = (event) => {
            if (event.key === 'Escape') close()
          }
          window.addEventListener('keydown', onKeyDown, true)
          return () => window.removeEventListener('keydown', onKeyDown, true)
        }, [open, close])

        const load = React.useCallback(async () => {
          if (typeof sessionId !== 'string') return
          setLoading(true)
          setError('')
          try {
            const response = await fetch(`/dsh-edit-rerun/turns?sessionId=${encodeURIComponent(sessionId)}`)
            const body = await response.json().catch(() => undefined)
            if (body === undefined || body.ok !== true) {
              throw new Error(body?.error ?? `host returned ${response.status}`)
            }
            setTurns(Array.isArray(body.turns) ? body.turns : [])
          } catch (cause) {
            setTurns([])
            setError(String(cause?.message ?? cause))
          } finally {
            setLoading(false)
          }
        }, [sessionId])

        const toggle = React.useCallback(() => {
          if (open) {
            close()
            return
          }
          const rect = buttonRef.current?.getBoundingClientRect()
          if (rect !== undefined) {
            setAnchor({
              bottom: Math.max(12, window.innerHeight - rect.top + 8),
              right: Math.max(12, window.innerWidth - rect.right),
            })
          }
          setOpen(true)
          void load()
        }, [open, close, load])

        const commit = React.useCallback(async () => {
          if (selected === null || typeof sessionId !== 'string') return
          setBusy(true)
          setError('')
          if (selected.boundarySeq === null) {
            setError(t('firstTurnBlocked'))
            setBusy(false)
            return
          }
          try {
            const childId = await ctx.sessions.fork({
              sessionId,
              atSeq: selected.boundarySeq,
              increaseTitle: true,
            })
            // Park the text for the child's composer *before* navigating: the
            // child mounts its own seat and reads it back.
            writePending({ sessionId: childId, text, at: Date.now() })
            ctx.uiWorkspace.openSession(childId)
            close()
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusy(false)
          }
        }, [selected, sessionId, text, close])

        if (typeof sessionId !== 'string') return null

        const rows = (turns ?? []).map((turn) =>
          h(
            'button',
            {
              key: turn.seq,
              type: 'button',
              onClick: () => {
                setSelected(turn)
                setText(turn.text)
                setError('')
              },
              style: {
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                margin: '0 0 4px',
                border: `1px solid ${theme.border}`,
                borderRadius: 7,
                background: 'transparent',
                color: theme.text,
                cursor: 'pointer',
              },
              onMouseEnter: (event) => { event.currentTarget.style.background = theme.hover },
              onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
            },
            h('div', { style: { fontSize: 11, color: theme.muted, marginBottom: 2 } },
              t('rowLabel', { index: turn.index })),
            h('div', {
              style: {
                fontSize: 12.5,
                color: theme.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, previewOf(turn.text)),
          ),
        )

        const editor = selected === null ? null : h(
          'div',
          null,
          h('div', { style: { fontSize: 11.5, color: theme.secondary, marginBottom: 6, lineHeight: 1.5 } },
            selected.boundarySeq === null
              ? t('noteFirst')
              : t('noteBranch', { index: selected.index })),
          h('textarea', {
            value: text,
            onChange: (event) => setText(event.target.value),
            spellCheck: false,
            style: {
              width: '100%',
              boxSizing: 'border-box',
              minHeight: 150,
              maxHeight: '38vh',
              padding: 8,
              border: `1px solid ${theme.border}`,
              borderRadius: 7,
              background: 'transparent',
              color: theme.text,
              fontSize: 12.5,
              lineHeight: 1.55,
              resize: 'vertical',
              fontFamily: 'inherit',
              outline: 'none',
            },
          }),
        )

        // The run action is refused for the first prompt: a fork can only be cut
        // after a completed turn, and there is none before turn 1.
        const firstTurn = selected !== null && selected.boundarySeq === null

        const headerRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, t('title')),
          h('div', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            onClick: close,
            title: t('close'),
            style: {
              border: 'none', background: 'transparent', color: theme.muted,
              cursor: 'pointer', fontSize: 15, lineHeight: '16px', padding: 2,
            },
          }, '\u00d7'),
        )

        const listBody = rows.length === 0
          ? h('div', { style: { color: theme.muted, padding: '10px 2px', lineHeight: 1.6 } }, t('empty'))
          : h('div', null,
            h('div', { style: { color: theme.muted, marginBottom: 8, lineHeight: 1.6 } }, t('pick')),
            rows,
          )

        const footerRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 } },
          h('button', {
            type: 'button',
            onClick: () => { setSelected(null); setText(''); setError('') },
            style: makeButtonStyle('ghost'),
          }, t('back')),
          h('div', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            disabled: busy || text.trim() === '' || firstTurn,
            onClick: () => { void commit() },
            style: {
              ...makeButtonStyle('primary'),
              opacity: busy || text.trim() === '' || firstTurn ? 0.55 : 1,
              cursor: busy || text.trim() === '' || firstTurn ? 'default' : 'pointer',
            },
          }, busy ? t('working') : (firstTurn ? t('firstTurnUnavailable') : t('run'))),
        )

        const editorBody = h('div', null,
          editor,
          footerRow,
          h('div', { style: { color: theme.muted, fontSize: 11, marginTop: 8, lineHeight: 1.5 } }, t('footnote')),
        )

        const dialogBody = selected === null
          ? (loading
            ? h('div', { style: { color: theme.muted, padding: '10px 2px' } }, t('loading'))
            : listBody)
          : editorBody

        const dialog = h('div', {
          role: 'dialog',
          'aria-label': t('title'),
          style: {
            position: 'fixed',
            zIndex: 9999,
            bottom: anchor.bottom,
            right: anchor.right,
            width: 460,
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: 'calc(100vh - 140px)',
            overflow: 'auto',
            boxSizing: 'border-box',
            padding: 12,
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            background: theme.panel,
            color: theme.text,
            boxShadow: theme.shadow,
            fontSize: 12.5,
          },
        },
          headerRow,
          error !== '' ? h('div', { style: { color: theme.danger, marginBottom: 8, lineHeight: 1.5 } }, error) : null,
          dialogBody,
        )

        const panel = !open ? null : h(React.Fragment, null,
          h('div', { onClick: close, style: { position: 'fixed', inset: 0, zIndex: 9998 } }),
          dialog,
        )

        return h(
          React.Fragment,
          null,
          h('button', {
            ref: buttonRef,
            type: 'button',
            'aria-label': t('title'),
            'aria-expanded': open,
            title: t('title'),
            onClick: toggle,
            style: {
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              borderRadius: 7,
              background: open ? theme.hover : 'transparent',
              color: theme.secondary,
              cursor: 'pointer',
              padding: 0,
            },
            onMouseEnter: (event) => { event.currentTarget.style.background = theme.hover },
            onMouseLeave: (event) => { event.currentTarget.style.background = open ? theme.hover : 'transparent' },
          }, h(RerunGlyph, { size: 15 })),
          panel,
        )
      }
    }

    const zh = {
      title: '编辑历史提示词并重跑',
      pick: '选一条要改的提示词。会在它之前分出一个新会话，原会话不动。',
      rowLabel: '第 {index} 轮',
      noteFirst: '这是本会话第一条提示词：它前面没有任何历史可以继承，所以不能在分支里重跑（DSH 只能从某一轮之后切分支）。要改这句就从现在开始新建一个会话。',
      firstTurnUnavailable: '第一轮不可重跑',
      firstTurnBlocked: '第一轮没有可继承的历史，无法在分支会话里重跑。',
      noteBranch: '会从第 {index} 轮之前分出新会话，把下面改好的提示词预填进输入框，由你按回车发送。',
      loading: '读取会话日志中…',
      empty: '这个会话还没有可重跑的提示词。',
      run: '在分支会话重跑',
      working: '正在创建…',
      back: '返回列表',
      close: '关闭',
      footnote: '原会话不会被改写——DSH 的会话日志是只追加的，所以「编辑历史」表现为「分出新分支」。',
    }

    const en = {
      title: 'Edit an earlier prompt and re-run it',
      pick: 'Pick a prompt to edit. A new conversation is forked before it; this one is left untouched.',
      rowLabel: 'Turn {index}',
      noteFirst: 'This is the first prompt of the conversation: there is no history before it, and a fork can only be cut after a completed turn, so it cannot be re-run as a branch.',
      firstTurnUnavailable: 'First turn needs no fork',
      firstTurnBlocked: 'The first prompt has no history to inherit, so it cannot be re-run in a fork.',
      noteBranch: 'Forks a new conversation before turn {index} and pre-fills the edited prompt in its composer for you to submit.',
      loading: 'Reading the session log…',
      empty: 'This conversation has no re-runnable prompt yet.',
      run: 'Re-run in fork',
      working: 'Creating…',
      back: 'Back',
      close: 'Close',
      footnote: 'The source conversation is never rewritten — the session log is append-only, so editing history means forking a branch.',
    }

    return {
      inject: ['slots', 'sessions', 'uiWorkspace', 'locale'],
      apply(ctx) {
        // Registering the same (namespace, locale) twice throws, and this apply
        // runs again on every HMR reload — so each dictionary is registered
        // defensively and a duplicate is not an error.
        const registerDict = (locale, dict) => {
          try {
            ctx.locale.register(NS, locale, dict)
          } catch (cause) {
            const message = String(cause?.message ?? cause)
            if (!message.includes('already has locale')) {
              console.warn('[dsh-edit-rerun] locale registration skipped:', message)
            }
          }
        }
        registerDict('zh', zh)
        registerDict('en', en)

        let t
        try {
          t = ctx.locale.bind(NS)
        } catch (cause) {
          console.error('[dsh-edit-rerun] locale bind failed:', cause)
          t = (key, params) => {
            const template = zh[key] ?? key
            if (typeof template !== 'string' || params === undefined) return template
            return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
          }
        }

        const Seat = makeSeat(ctx, t)
        ctx.effect(() => {
          const dispose = ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(
              { name: 'conversation.input.right', id: 'rerun', order: 90, label: () => t('title') },
              Seat,
            ),
          )
          return () => dispose()
        }, 'dsh-edit-rerun: composer input seat')
      },
    }
  },
})
