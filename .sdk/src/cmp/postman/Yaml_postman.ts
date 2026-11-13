// YAML for the document shapes a Postman collection holds: maps, lists of
// maps or scalars, and strings that are often multi-line scripts.

const PLAIN = /^[A-Za-z_][A-Za-z0-9_ ./:()-]*$/
const KEYWORD = /^(true|false|null|yes|no|on|off|y|n|~)$/i
const KEY = /^[$A-Za-z_][A-Za-z0-9_.$-]*$/


function isMap(v: any): boolean {
  return null != v && 'object' === typeof v && !Array.isArray(v)
}


// JSON text is a valid YAML double-quoted scalar, so anything not plainly
// safe is written that way.
function scalar(v: any): string {
  if (null == v) return 'null'
  if ('boolean' === typeof v) return String(v)
  if ('number' === typeof v) return Number.isFinite(v) ? String(v) : JSON.stringify(String(v))
  const s = String(v)
  return PLAIN.test(s) && !KEYWORD.test(s) && !/: |:$| #|\s$/.test(s) ? s : JSON.stringify(s)
}


function key(k: string): string {
  return KEY.test(k) ? k : JSON.stringify(k)
}


// A literal block keeps a script readable, where every character of each
// line survives as written: no tab, no carriage return, no trailing space.
function literal(s: string): boolean {
  return s.includes('\n') && !/^\s/.test(s) && !s.endsWith('\n') &&
    !/[\t\r]/.test(s) && !/ \n/.test(s)
}


function lines(node: any, indent: number): string[] {
  const pad = ' '.repeat(indent)

  if (Array.isArray(node)) {
    return node.filter((item: any) => undefined !== item).flatMap((item: any) => {
      if (!isMap(item)) return [pad + '- ' + scalar(item)]
      const inner = lines(item, indent + 2)
      if (0 === inner.length) return [pad + '- {}']
      inner[0] = pad + '- ' + inner[0].slice(indent + 2)
      return inner
    })
  }

  return Object.entries(node)
    .filter(([, v]) => undefined !== v)
    .flatMap(([k, v]: [string, any]) => {
      const head = pad + key(k) + ':'
      if (isMap(v)) {
        return 0 === Object.keys(v).length ? [head + ' {}'] : [head, ...lines(v, indent + 2)]
      }
      if (Array.isArray(v)) {
        return 0 === v.length ? [head + ' []'] : [head, ...lines(v, indent + 2)]
      }
      if ('string' === typeof v && literal(v)) {
        return [head + ' |-', ...v.split('\n').map((l: string) => '' === l ? '' : pad + '  ' + l)]
      }
      return [head + ' ' + scalar(v)]
    })
}


function yaml(doc: Record<string, any>): string {
  return lines(doc, 0).join('\n') + '\n'
}


export {
  yaml,
}
