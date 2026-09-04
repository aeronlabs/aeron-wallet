/**
 * Pulling `--name value` out of an argument list.
 *
 * Small on purpose: the CLI takes positional arguments that mean different
 * things per command, so a flag has to be lifted out before the positions are
 * read, or `pay <url> <body>` starts seeing `--method` as its body.
 */

export type TakenFlag = {
  /** The flag's value, or undefined when the flag was not given. */
  readonly value: string | undefined
  /** The arguments with the flag and its value removed. */
  readonly rest: string[]
}

export function takeFlag(argv: readonly string[], name: string): TakenFlag {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return { value: undefined, rest: [...argv] }

  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return { value, rest: [...argv.slice(0, at), ...argv.slice(at + 2)] }
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type HttpMethod = (typeof METHODS)[number]

/**
 * The method to call a resource with.
 *
 * Defaults to POST, which is what most paid endpoints take — but plenty are
 * plain GETs, and a wallet that can only POST cannot pay them at all.
 */
export function parseMethod(raw: string | undefined): HttpMethod {
  if (raw === undefined) return 'POST'
  const method = raw.toUpperCase()
  if (!METHODS.includes(method as never)) {
    throw new Error(`--method must be one of ${METHODS.join(', ')}`)
  }
  return method as HttpMethod
}
