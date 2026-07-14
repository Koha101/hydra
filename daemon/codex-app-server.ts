export type CodexForkOptions = {
  cwd?: string
  model?: string
  timeoutMs?: number
}

export type CodexAppServerProcess = {
  stdin: {
    write(data: string | Uint8Array): unknown
    flush?(): unknown
    end?(): unknown
  }
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  kill(): unknown
}

export type CodexAppServerSpawn = (cwd?: string) => CodexAppServerProcess

const spawnCodexAppServer: CodexAppServerSpawn = cwd => Bun.spawn(
  ['codex', 'app-server', '--stdio'],
  {
    cwd: cwd || process.cwd(),
    env: process.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  },
) as unknown as CodexAppServerProcess

export function buildCodexForkParams(sourceThreadId: string, options: CodexForkOptions = {}): Record<string, unknown> {
  return {
    threadId: sourceThreadId,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.model && options.model !== 'default' ? { model: options.model } : {}),
    sandbox: 'workspace-write',
  }
}

function rpcError(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, unknown>).message as string
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

function createMessageReader(stream: ReadableStream<Uint8Array>): () => Promise<Record<string, unknown>> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  return async () => {
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
      }

      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        const line = buffer.trim()
        buffer = ''
        if (line) {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {}
        }
        throw new Error('Codex app server closed before returning a response')
      }
      buffer += decoder.decode(value, { stream: true })
    }
  }
}

/** Fork a persisted Codex conversation through the official app-server protocol. */
export async function forkCodexSession(
  sourceThreadId: string,
  options: CodexForkOptions = {},
  spawn: CodexAppServerSpawn = spawnCodexAppServer,
): Promise<string> {
  if (!sourceThreadId.trim()) throw new Error('Codex source conversation ID is required')

  const child = spawn(options.cwd)
  const nextMessage = createMessageReader(child.stdout)
  const timeoutMs = options.timeoutMs ?? 15_000
  let timeout: ReturnType<typeof setTimeout> | undefined

  const send = (message: Record<string, unknown>) => {
    child.stdin.write(JSON.stringify(message) + '\n')
    child.stdin.flush?.()
  }
  const readResponse = async (id: number): Promise<Record<string, unknown>> => {
    for (;;) {
      const message = await nextMessage()
      if (message.id !== id) continue
      if (message.error !== undefined) throw new Error(`Codex app server: ${rpcError(message.error)}`)
      const result = message.result
      if (!result || typeof result !== 'object') throw new Error('Codex app server returned an invalid response')
      return result as Record<string, unknown>
    }
  }

  const exchange = async (): Promise<string> => {
    send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'hydra', title: 'Hydra', version: '1' } },
    })
    await readResponse(0)
    send({ method: 'initialized', params: {} })
    send({ method: 'thread/fork', id: 1, params: buildCodexForkParams(sourceThreadId, options) })
    const result = await readResponse(1)
    const thread = result.thread
    const forkedId = thread && typeof thread === 'object' ? (thread as Record<string, unknown>).id : undefined
    if (typeof forkedId !== 'string' || !forkedId) {
      throw new Error('Codex app server did not return the forked conversation ID')
    }
    return forkedId
  }

  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      try { child.kill() } catch {}
      reject(new Error(`Codex fork timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([exchange(), timedOut])
  } finally {
    if (timeout) clearTimeout(timeout)
    try { child.stdin.end?.() } catch {}
    try { child.kill() } catch {}
  }
}
