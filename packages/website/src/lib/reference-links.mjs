import { statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceRoute, repositoryUrl } from './reference-docs.mjs';

const repoRoot = new URL('../../../../', import.meta.url);
const repoPath = fileURLToPath(repoRoot);

function repoFile(url) {
  return relative(repoPath, fileURLToPath(url)).split(sep).join('/');
}

export function referenceLinksPlugin(base) {
  return {
    name: 'mearl-reference-links',
    element: {
      filter: ['a'],
      visit(node, context) {
        const href = node.properties?.href;
        if (!context.fileURL || typeof href !== 'string' || !href || /^(?:[a-z][a-z0-9+.-]*:|[/#?])/i.test(href)) return;
        if (!referenceRoute(repoFile(context.fileURL))) return;
        const target = new URL(href, context.fileURL);
        const file = repoFile(target);
        const route = referenceRoute(file);
        const suffix = target.search + target.hash;
        if (route) {
          context.setProperty(node, 'href', base + route + suffix);
          return;
        }
        const kind = statSync(target, { throwIfNoEntry: false })?.isDirectory() ? 'tree' : 'blob';
        const path = file.split('/').map(encodeURIComponent).join('/');
        context.setProperty(node, 'href', `${repositoryUrl}/${kind}/main/${path}${suffix}`);
      },
    },
  };
}
