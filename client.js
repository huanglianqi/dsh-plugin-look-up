/**
 * dsh-plugin-look-up — browser half.
 *
 * A selection pill and a definition card on `shell.overlay`. The card asks the
 * Host for a macOS system-dictionary definition (the same local data Look Up
 * reads); nothing leaves the machine. The plugin is inert outside macOS and
 * says so instead of failing silently.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-look-up',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'look-up'
    const LOOKUP_URL = '/plugin/look-up/lookup'
    const OPEN_URL = '/plugin/look-up/open'
    const MAX_WORD_LENGTH = 64
    const CARD_WIDTH = 380

    /** Runtime copy; the package locale files carry only the plugin metadata. */
    const STRINGS = {
      en: {
        lookUp: 'Look Up',
        loading: 'Looking up in the system dictionary…',
        noEntry: 'No system-dictionary entry for “{word}”.',
        unsupported: 'System-dictionary lookup is available on macOS only.',
        helperMissing: 'The dictionary helper is missing. Reinstall the plugin.',
        timeout: 'The dictionary took too long. Try again.',
        failed: 'Lookup failed. Try again.',
        copy: 'Copy',
        copied: 'Copied',
        openInDictionary: 'Open in Dictionary',
        source: 'macOS system dictionaries · offline',
        close: 'Close',
        lookUpFor: 'Look up “{word}”'
      },
      zh: {
        lookUp: '查词',
        loading: '正在查询系统词典…',
        noEntry: '系统词典中没有找到“{word}”。',
        unsupported: '系统词典查询仅支持 macOS。',
        helperMissing: '词典组件缺失，请重新安装插件。',
        timeout: '查询超时，请重试。',
        failed: '查询失败，请重试。',
        copy: '复制',
        copied: '已复制',
        openInDictionary: '在词典中打开',
        source: 'macOS 系统词典 · 本地查询',
        close: '关闭',
        lookUpFor: '查询“{word}”'
      }
    }

    const CSS = `
.dlu-root {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.dlu-pill {
  position: fixed;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .25));
  background: var(--dsw-alias-bg-overlay, Canvas);
  color: var(--dsw-alias-label-primary, CanvasText);
  box-shadow: 0 6px 20px rgba(0, 0, 0, .16), 0 1px 3px rgba(0, 0, 0, .10);
  backdrop-filter: blur(18px) saturate(1.3);
  -webkit-backdrop-filter: blur(18px) saturate(1.3);
  font-size: 12px;
  font-weight: 560;
  line-height: 1;
  letter-spacing: .01em;
  white-space: nowrap;
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  animation: dlu-in 120ms cubic-bezier(.2, .8, .3, 1);
}
.dlu-pill:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, Canvas));
}
.dlu-pill:active {
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-2, Canvas));
}
.dlu-pill:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, Highlight);
  outline-offset: 2px;
}
.dlu-pill svg { width: 13px; height: 13px; flex: none; opacity: .82; }

.dlu-card {
  position: fixed;
  display: flex;
  flex-direction: column;
  width: ${CARD_WIDTH}px;
  max-width: calc(100vw - 24px);
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .25));
  background: var(--dsw-alias-bg-overlay, Canvas);
  color: var(--dsw-alias-label-primary, CanvasText);
  box-shadow:
    0 24px 64px rgba(0, 0, 0, .24),
    0 8px 24px rgba(0, 0, 0, .14),
    0 1px 0 rgba(255, 255, 255, .04) inset;
  backdrop-filter: blur(26px) saturate(1.4);
  -webkit-backdrop-filter: blur(26px) saturate(1.4);
  pointer-events: auto;
  animation: dlu-in 140ms cubic-bezier(.2, .8, .3, 1);
}
.dlu-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 13px 12px 9px 16px;
}
.dlu-titles { min-width: 0; }
.dlu-word {
  font-size: 16px;
  font-weight: 680;
  line-height: 1.25;
  letter-spacing: -.012em;
  overflow-wrap: anywhere;
}
.dlu-phonetic {
  margin-top: 3px;
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  overflow-wrap: anywhere;
}
.dlu-close {
  margin-left: auto;
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, GrayText);
  cursor: pointer;
}
.dlu-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, CanvasText); }
.dlu-close:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, Highlight); outline-offset: 1px; }
.dlu-close svg { width: 14px; height: 14px; }

.dlu-body {
  padding: 1px 16px 14px;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: 13.5px;
  line-height: 1.64;
  color: var(--dsw-alias-label-primary, CanvasText);
  scrollbar-width: thin;
}
.dlu-body p { margin: 0 0 9px; }
.dlu-body p:last-child { margin-bottom: 0; }
.dlu-body b, .dlu-body strong { font-weight: 640; }
.dlu-empty {
  color: var(--dsw-alias-label-secondary, GrayText);
  font-size: 13px;
  line-height: 1.6;
}
.dlu-empty.is-error { color: var(--dsw-alias-state-error-primary, #d9534f); }
.dlu-loading { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary, GrayText); font-size: 13px; }
.dlu-dots { display: inline-flex; gap: 3px; }
.dlu-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #4c8dff);
  animation: dlu-pulse 900ms ease-in-out infinite;
}
.dlu-dot:nth-child(2) { animation-delay: 120ms; }
.dlu-dot:nth-child(3) { animation-delay: 240ms; }

.dlu-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px 9px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .2));
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, Canvas) 55%, transparent);
}
.dlu-source {
  margin-right: auto;
  font-size: 10.5px;
  line-height: 1.3;
  color: var(--dsw-alias-label-tertiary, GrayText);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dlu-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-size: 11px;
  font-weight: 550;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.dlu-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, CanvasText); }
.dlu-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, Highlight); outline-offset: 1px; }
.dlu-btn[data-copied="true"] { color: var(--dsw-alias-state-success-primary, #2e9e5b); }

@keyframes dlu-in {
  from { opacity: 0; transform: translateY(3px) scale(.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes dlu-pulse {
  0%, 100% { opacity: .25; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-2px); }
}
@media (prefers-reduced-motion: reduce) {
  .dlu-pill, .dlu-card { animation: none; }
  .dlu-dot { animation: none; opacity: .7; }
}
`

    const ICON_LOOKUP = h('svg', {
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      'aria-hidden': true
    }, h('circle', { cx: 7, cy: 7, r: 4.2 }), h('path', { d: 'M10.2 10.2 13.5 13.5' }))

    const ICON_CLOSE = h('svg', {
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      'aria-hidden': true
    }, h('path', { d: 'M4 4l8 8M12 4l-8 8' }))

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    /** The element carrying a DOM node, or null. */
    function elementOf(node) {
      if (node === null || node === undefined) return null
      return node.nodeType === 1 ? node : node.parentElement ?? null
    }

    /** Read the current non-collapsed selection when it is worth looking up. */
    function readSelection() {
      const selection = window.getSelection()
      if (selection === null || selection === undefined || selection.isCollapsed || selection.rangeCount === 0) return null
      const word = selection.toString().replace(/\s+/gu, ' ').trim()
      if (word.length === 0 || word.length > MAX_WORD_LENGTH) return null
      if (!/[0-9A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/u.test(word)) return null

      const range = selection.getRangeAt(0)
      const holder = elementOf(range.commonAncestorContainer)
      if (holder === null) return null
      if (holder.closest('.dlu-root, input, textarea, pre, .cm-editor, [contenteditable="true"]') !== null) return null

      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      return {
        word,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      }
    }

    /** Place the small trigger above the selection, or below when there is no room. */
    function pillPosition(rect) {
      const width = 88
      const height = 30
      const left = clamp(rect.right - width / 2, 8, Math.max(8, window.innerWidth - width - 8))
      const above = rect.top - height - 7
      const top = above >= 8 ? above : rect.bottom + 7
      return { left, top }
    }

    /** Place the card next to the selection, preferring the roomier side. */
    function cardPosition(rect) {
      const width = Math.min(CARD_WIDTH, window.innerWidth - 24)
      const left = clamp(rect.left, 12, Math.max(12, window.innerWidth - width - 12))
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      if (below >= 240 || below >= above) {
        return { left, top: rect.bottom + 10, width, maxHeight: Math.max(120, below - 104) }
      }
      return { left, bottom: window.innerHeight - rect.top + 10, width, maxHeight: Math.max(120, above - 104) }
    }

    /**
     * Split a raw DictionaryServices entry into a phonetic line and readable
     * paragraphs. The raw form is `headword | pronunciation | sense ...` for
     * English, and `headword pinyin ①sense ...` for Chinese.
     */
    function parseDefinition(text, word) {
      const source = String(text ?? '').trim()
      if (source.length === 0) return { phonetic: '', paragraphs: [] }

      let segments = source.split(/\s*\|\s*/u).map((part) => part.trim()).filter(Boolean)
      let phonetic = ''
      let bodySegments = [source]
      if (segments.length > 1 && (/[ˈˌəʃʒθðŋæɑɔɪʊɛɜːɒʌ]/u.test(segments[1]) || /^(?:BrE|AmE|US|UK)\b/u.test(segments[1]))) {
        phonetic = segments[1]
        bodySegments = segments.slice(2)
      } else if (segments.length > 1 && /^(?:noun|verb|adjective|adverb|pronoun|preposition|conjunction|determiner|exclamation|interjection|numeral|auxiliary|phrasal verb)\b/iu.test(segments[1])) {
        bodySegments = segments.slice(1)
      }
      if (bodySegments.length === 0) bodySegments = [source]

      // Chinese entries use "|" between example phrases, not between the
      // headword and the senses, so only the phonetic/POS split above applies.
      let body = bodySegments.join('\n\n').trim()
      if (body.toLowerCase().startsWith(word.toLowerCase())) body = body.slice(word.length).trim()
      if (body.length === 0) body = source

      body = body
        .replace(/\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])/gu, '\n$1')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()

      const paragraphs = body.split(/\n+/u).map((part) => part.trim()).filter(Boolean)
      return { phonetic, paragraphs: paragraphs.length > 0 ? paragraphs : [body] }
    }

    /** Re-render whenever the locale dictionary or active locale changes. */
    function useLocaleVersion(locale) {
      const [, setVersion] = useState(0)
      useEffect(() => locale.subscribe(() => setVersion((value) => value + 1)), [locale])
    }

    function LookUpLayer({ locale }) {
      useLocaleVersion(locale)
      const t = locale.bind(NS)

      const [pill, setPill] = useState(null)
      const [card, setCard] = useState(null)
      const [copied, setCopied] = useState(false)
      const [opening, setOpening] = useState(false)
      const cardRef = useRef(null)
      const requestRef = useRef(0)

      useEffect(() => {
        cardRef.current = card
      }, [card])

      useEffect(() => {
        setCopied(false)
        setOpening(false)
      }, [card ? card.requestId : 0])

      const closeAll = useCallback(() => {
        setPill(null)
        setCard(null)
      }, [])

      const openCard = useCallback((selection) => {
        setPill(null)
        requestRef.current += 1
        const requestId = requestRef.current
        setCard({
          word: selection.word,
          requestId,
          status: 'loading',
          result: null,
          code: null,
          position: cardPosition(selection.rect)
        })
      }, [])

      // Ask the Host once per opened card.
      useEffect(() => {
        if (card === null || card.status !== 'loading') return undefined
        const requestId = card.requestId
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), 8000)
        let live = true

        const settle = (patch) => {
          if (!live) return
          setCard((current) => current !== null && current.requestId === requestId ? { ...current, ...patch } : current)
        }

        fetch(LOOKUP_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word: card.word }),
          signal: controller.signal
        })
          .then((response) => response.json())
          .then((data) => {
            if (data !== null && typeof data === 'object' && data.ok === true) {
              settle({ status: 'ready', result: data })
            } else {
              settle({ status: 'error', code: data !== null && typeof data === 'object' ? data.code ?? 'failed' : 'failed' })
            }
          })
          .catch((error) => {
            settle({ status: 'error', code: error !== null && error !== undefined && error.name === 'AbortError' ? 'timeout' : 'failed' })
          })
          .finally(() => window.clearTimeout(timer))

        return () => {
          live = false
          window.clearTimeout(timer)
          controller.abort()
        }
      }, [card === null ? null : card.requestId])

      // Selection trigger.
      useEffect(() => {
        let timer = 0

        const inspect = () => {
          if (cardRef.current !== null) return
          const selection = readSelection()
          if (selection === null) {
            setPill(null)
            return
          }
          setPill({ ...selection, position: pillPosition(selection.rect) })
        }

        const onMouseUp = (event) => {
          const target = elementOf(event.target)
          if (target !== null && target.closest('.dlu-root') !== null) return
          window.clearTimeout(timer)
          timer = window.setTimeout(inspect, 0)
        }

        const onKeyUp = (event) => {
          if (event.key !== 'Shift' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          window.clearTimeout(timer)
          timer = window.setTimeout(inspect, 0)
        }

        window.addEventListener('mouseup', onMouseUp)
        window.addEventListener('keyup', onKeyUp)
        return () => {
          window.clearTimeout(timer)
          window.removeEventListener('mouseup', onMouseUp)
          window.removeEventListener('keyup', onKeyUp)
        }
      }, [])

      // Dismissal: outside click, Escape, page scroll, viewport resize.
      useEffect(() => {
        const onMouseDown = (event) => {
          const target = elementOf(event.target)
          if (target !== null && target.closest('.dlu-root') !== null) return
          if (cardRef.current !== null) setCard(null)
          setPill(null)
        }

        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            setPill(null)
            setCard(null)
          }
        }

        const onScroll = (event) => {
          const target = elementOf(event.target)
          if (target !== null && target.closest('.dlu-card') !== null) return
          setPill(null)
          if (cardRef.current !== null) setCard(null)
        }

        const onResize = () => {
          setPill(null)
          if (cardRef.current !== null) setCard(null)
        }

        const onSelectionChange = () => {
          if (cardRef.current !== null) return
          const selection = window.getSelection()
          if (selection === null || selection === undefined || selection.isCollapsed) setPill(null)
        }

        window.addEventListener('mousedown', onMouseDown)
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('resize', onResize)
        document.addEventListener('scroll', onScroll, true)
        document.addEventListener('selectionchange', onSelectionChange)
        return () => {
          window.removeEventListener('mousedown', onMouseDown)
          window.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('resize', onResize)
          document.removeEventListener('scroll', onScroll, true)
          document.removeEventListener('selectionchange', onSelectionChange)
        }
      }, [])

      const copyWord = useCallback((word) => {
        const finish = () => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        }
        if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(word).then(finish, finish)
          return
        }
        finish()
      }, [])

      const openInDictionary = useCallback((word) => {
        setOpening(true)
        fetch(OPEN_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word })
        })
          .catch(() => undefined)
          .finally(() => setOpening(false))
      }, [])

      const result = card !== null && card.status === 'ready' ? card.result : null
      const parsed = result !== null ? parseDefinition(result.definition, result.word ?? card.word) : null

      const errorText = (() => {
        if (card === null || card.status !== 'error') return ''
        if (card.code === 'unsupported') return t('unsupported')
        if (card.code === 'helper-missing') return t('helperMissing')
        if (card.code === 'timeout') return t('timeout')
        if (card.code === 'no-entry') return t('noEntry', { word: card.word })
        return t('failed')
      })()

      return h('div', { className: 'dlu-root', style: { pointerEvents: 'none' } },
        h('style', null, CSS),

        pill !== null
          ? h('button', {
              type: 'button',
              className: 'dlu-pill',
              style: { left: `${pill.position.left}px`, top: `${pill.position.top}px` },
              title: t('lookUpFor', { word: pill.word }),
              'aria-label': t('lookUpFor', { word: pill.word }),
              onMouseDown: (event) => {
                event.preventDefault()
                event.stopPropagation()
              },
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                openCard(pill)
              }
            }, ICON_LOOKUP, h('span', null, t('lookUp')))
          : null,

        card !== null
          ? h('div', {
              className: 'dlu-card',
              role: 'dialog',
              'aria-label': card.word,
              style: {
                left: `${card.position.left}px`,
                width: `${card.position.width}px`,
                ...(card.position.top !== undefined ? { top: `${card.position.top}px` } : {}),
                ...(card.position.bottom !== undefined ? { bottom: `${card.position.bottom}px` } : {})
              }
            },
            h('div', { className: 'dlu-head' },
              h('div', { className: 'dlu-titles' },
                h('div', { className: 'dlu-word' }, result !== null ? result.word ?? card.word : card.word),
                parsed !== null && parsed.phonetic !== '' ? h('div', { className: 'dlu-phonetic' }, parsed.phonetic) : null
              ),
              h('button', {
                type: 'button',
                className: 'dlu-close',
                'aria-label': t('close'),
                title: t('close'),
                onMouseDown: (event) => event.stopPropagation(),
                onClick: () => setCard(null)
              }, ICON_CLOSE)
            ),
            h('div', { className: 'dlu-body', style: { maxHeight: `${card.position.maxHeight}px` } },
              card.status === 'loading'
                ? h('div', { className: 'dlu-loading' },
                    h('span', null, t('loading')),
                    h('span', { className: 'dlu-dots' },
                      h('span', { className: 'dlu-dot' }),
                      h('span', { className: 'dlu-dot' }),
                      h('span', { className: 'dlu-dot' })
                    )
                  )
                : null,
              card.status === 'error'
                ? h('div', { className: 'dlu-empty is-error' }, errorText)
                : null,
              card.status === 'ready' && parsed !== null
                ? parsed.paragraphs.map((paragraph, index) => h('p', { key: index }, paragraph))
                : null
            ),
            h('div', { className: 'dlu-foot' },
              h('span', { className: 'dlu-source' }, t('source')),
              card.status === 'ready'
                ? h('button', {
                    type: 'button',
                    className: 'dlu-btn',
                    'data-copied': copied ? 'true' : undefined,
                    onMouseDown: (event) => event.stopPropagation(),
                    onClick: () => copyWord(result.word ?? card.word)
                  }, copied ? t('copied') : t('copy'))
                : null,
              card.status === 'ready' && navigator.platform !== undefined && /Mac/u.test(navigator.platform)
                ? h('button', {
                    type: 'button',
                    className: 'dlu-btn',
                    disabled: opening,
                    onMouseDown: (event) => event.stopPropagation(),
                    onClick: () => openInDictionary(result.word ?? card.word)
                  }, t('openInDictionary'))
                : null
            )
          )
          : null
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, STRINGS), 'look-up: copy')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'look-up',
          order: 55
        }, () => h(LookUpLayer, { locale: ctx.locale })))
      }
    }
  }
})
