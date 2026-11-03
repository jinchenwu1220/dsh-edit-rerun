/**
 * dsh-edit-rerun — host half.
 *
 * Serves the editable prompt list for one Session
 * (`GET /dsh-edit-rerun/turns?sessionId=…`) and announces the gesture to the agent.
 * All the log parsing lives in `./log.js`; this file only owns the route.
 *
 * The browser half (exports "./client") is served by client-modules from the
 * same package's `dsh.client` declaration.
 *
 * @module dsh-edit-rerun
 */

import { readTurns } from './log.js'

/** Required services: the HTTP route registry and the prompt band. */
export const inject = ['webServer', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 216

/** Model-facing announcement: what the button does and what it cannot do. */
export const RERUN_GUIDANCE =
  '本机已安装 dsh-edit-rerun 插件（Web GUI 的「编辑历史重跑」）：输入框右侧有回环箭头按钮，点开会列出本会话每一条用户提示词，选中可改字，然后在**分出的新会话**里重跑，并把改好的原文预填进输入框等你按回车。它不会改写原会话的历史（会话日志是 append-only 的），所以「编辑历史消息」在本机等于「分出新分支并改词重跑」。第一轮提示词前面没有可继承的历史，不能重跑。用户说「重跑 / 从某一轮重来 / 改一下刚才那句再跑」时即指本插件。'

/** JSON reply helper. */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Mount the turns route.
 * @param ctx - context carrying webServer.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const handler = async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh')
        if (url.pathname !== '/dsh-edit-rerun/turns') {
          json(res, 404, { ok: false, error: 'not found' })
          return
        }
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const result = await readTurns(sessionId)
        json(res, 200, { ok: true, sessionId: result.sessionId, turns: result.turns })
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
    return ctx.webServer.register({ kind: 'prefix', path: '/dsh-edit-rerun', handler })
  }, 'dsh-edit-rerun: turns route')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:rerun',
    order: SECTION_ORDER,
    text: RERUN_GUIDANCE,
  }), 'dsh-edit-rerun: prompt section')
}
