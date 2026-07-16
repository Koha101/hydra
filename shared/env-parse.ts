/** Parse a single .env line into [key, value], handling `export`, quotes, and inline comments. */
export function parseEnvLine(line: string): [string, string] | null {
  const m = line.match(/^(?:export\s+)?(\w+)=(.*)$/)
  if (!m) return null
  let val = m[2]
  if (val.startsWith('"')) {
    val = val.slice(1)
    const end = val.indexOf('"')
    if (end !== -1) val = val.slice(0, end)
  } else if (val.startsWith("'")) {
    val = val.slice(1)
    const end = val.indexOf("'")
    if (end !== -1) val = val.slice(0, end)
  } else {
    val = val.replace(/\s+#.*$/, '').trimEnd()
  }
  return [m[1], val]
}
