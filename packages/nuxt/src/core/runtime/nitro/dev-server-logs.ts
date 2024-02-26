import type { LogObject } from 'consola'
import { createConsola } from 'consola'
import devalue from '@nuxt/devalue'
import { createHooks } from 'hookable'
import { defineEventHandler, setHeaders, setResponseStatus } from 'h3'
import { withTrailingSlash } from 'ufo'

import type { NitroApp } from '#internal/nitro/app'

// @ts-expect-error virtual file
import { rootDir } from '#internal/dev-server-logs-options'

const originalConsole = {
  log: console.log,
  warn: console.warn,
  info: console.info,
  error: console.error,
}

export default (nitroApp: NitroApp) => {
  const hooks = createHooks<{ log: (data: any) => void }>()
  const logs: LogObject[] = []

  onConsoleLog((_log) => {
    const stack = getStack()

    const log = {
      ..._log,
      // Pass along filename to allow the client to display more info about where log comes from
      filename: extractFilenameFromStack(stack),
      // Clean up file names in stack trace
      stack: normalizeFilenames(stack)
    }

    // retain log to be include in the next render
    logs.push(log)
    // send log messages to client via SSE
    hooks.callHook('log', log)
  })

  // Add SSE endpoint for streaming logs to the client
  nitroApp.router.add('/_nuxt_logs', defineEventHandler(async (event) => {
    setResponseStatus(event, 200)
    setHeaders(event, {
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'content-type': 'text/event-stream'
    })

    // Let Nitro know the connection is opened
    event._handled = true

    let counter = 0

    hooks.hook('log', data => {
      event.node.res.write(`id: ${++counter}\n`)
      event.node.res.write(`data: ${JSON.stringify(data)}\n\n`)
    })
  }))

  // Pass any unhandled logs to the client
  nitroApp.hooks.hook('render:html', htmlContext => {
    htmlContext.bodyAppend.unshift(`<script>window.__NUXT_LOGS__ = ${devalue(logs)}</script>`)
    logs.length = 0
  })
}

const EXCLUDE_TRACE_RE = new RegExp('^.*at.*(\\/node_modules\\/(.*\\/)?(nuxt|consola|@vue)\\/.*|core\\/runtime\\/nitro.*)$\\n?', 'gm')
function getStack () {
  // Pass along stack traces if needed (for error and warns)
  const stack = new Error()
  Error.captureStackTrace(stack)
  return stack.stack?.replace(EXCLUDE_TRACE_RE, '').replace(/^Error.*\n/, '') || ''
}

const FILENAME_RE = /at.*\(([^:)]+)[):]/
const FILENAME_RE_GLOBAL = /at.*\(([^)]+)\)/g
function extractFilenameFromStack (stacktrace: string) {
  return stacktrace.match(FILENAME_RE)?.[1].replace(withTrailingSlash(rootDir), '')
}
function normalizeFilenames (stacktrace: string) {
  // remove line numbers and file: protocol - TODO: sourcemap support for line numbers
  return stacktrace.replace(FILENAME_RE_GLOBAL, (match, filename) => match.replace(filename, filename.replace('file:///', '/').replace(/:.*$/, '')))
}

function onConsoleLog (callback: (log: LogObject) => void) {
  const logger = createConsola({
    reporters: [
      {
        log (logObj) {
          // Don't swallow log messages in console - is there a better way to do this @pi0?
          // TODO: display (clickable) filename in server log as well when we use consola for this
          (originalConsole[logObj.type as 'log'] || originalConsole.log)(...logObj.args)

          callback(logObj)
        },
      }
    ]
  })
  logger.wrapAll()
}