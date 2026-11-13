import {
  cmp, File, Content, Folder,
} from '@voxgig/sdkgen'

import { catalogue } from './Catalogue_postman'
import { collectionFiles } from './Collection_postman'


// Postman's local-workspace layout under the target folder, which is the
// `postman/` directory a Postman project root holds.
const Main = cmp(function Main(props: any) {
  const { target, ctx$ } = props

  const cat = catalogue(ctx$.model, ctx$.meta?.apidef)

  for (const n of cat.notes) {
    ctx$.log?.warn?.({
      point: 'postman-left-out',
      target: target.name,
      note: [n.entity, n.flow, n.op].filter((x: any) => null != x).join(' ') +
        (null != n.entity || null != n.flow ? ': ' : '') + n.note,
    })
  }

  emit(collectionFiles(cat))
})


function emit(files: Record<string, string>): void {
  const tree: any = {}
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/')
    let node = tree
    for (const dir of parts.slice(0, -1)) node = (node[dir] = node[dir] || {})
    node[parts[parts.length - 1]] = text
  }

  const walk = (node: any) => {
    for (const name of Object.keys(node).sort()) {
      const v = node[name]
      if ('string' === typeof v) File({ name }, () => Content(v))
      else Folder({ name }, () => walk(v))
    }
  }
  walk(tree)
}


export {
  Main,
}
