// Every daemon-side copy and removal of resource data goes through here, so
// that a daemon running as an ordinary user on Linux can still branch,
// snapshot, restore, reset and remove projects whose files belong to a
// container's user (a PGDATA owned by the postgres image's uid with mode
// 0700; root-owned files a worker wrote into its state directory). The
// native operation always runs first and the container fallback only on
// EACCES or EPERM: copyTree and removeTree in packages/core/src/copy.ts have
// the reasoning, createContainerTreeOps in packages/core/src/docker.ts the
// container. On macOS and for a root daemon the native operation succeeds,
// no container runs, and behaviour is what it was.
//
// Which image runs the fallback. Never one that has to be pulled: a removal
// that downloads an image is a surprise on a slow link and a failure on an
// offline box, so every candidate is checked locally and `--pull never` is
// on the run. Candidates, in order:
//
//   1. The postgres images of the resources being copied or removed. For a
//      PGDATA that is the resource's own image, which created the files and
//      was pulled before the resource could exist.
//   2. Their app and worker images, which this box built.
//   3. The configured default postgres image, then every other postgres
//      image a resource on this box uses.
//   4. Caddy's image (caddy.ts), local whenever the front door has run.
//   5. The worker runtime's base image (NODE_IMAGE), local whenever a worker
//      has been built here.
//
// The later entries matter for `hobby rm` of a project with workers:
// destroyWorker removes the worker's own image before the project directory
// is removed, so by then (2) may be gone. Every candidate is a stock image
// with sh, cp, rm, find, stat and awk. Most are alpine, whose busybox cp has
// no --reflink, so the container copy of a PGDATA is a full copy and is
// reported as one; GNU-cp images reflink where the filesystem can.

import {
  copyTree,
  createContainerTreeOps,
  removeTree,
  type CloneResult,
  type ElevatedTreeOps,
  type Resource,
} from '@hobby.sh/core'
import { NODE_IMAGE } from '@hobby.sh/worker'
import { CADDY_IMAGE } from './caddy.js'
import type { DaemonContext } from './context.js'

export interface TreeOps {
  clone(src: string, dst: string): Promise<CloneResult>
  remove(path: string): Promise<void>
}

// Anything with a kind and a config: a live Resource, or a snapshot
// manifest's entry for one.
export type ImageSource = Pick<Resource, 'kind'> & { config: unknown }

function imageOf(source: ImageSource): string | null {
  const config = source.config
  if (config === null || typeof config !== 'object') {
    return null
  }
  const image = (config as { image?: unknown }).image
  return typeof image === 'string' && image.length > 0 ? image : null
}

export function fallbackImages(ctx: DaemonContext, sources: ImageSource[]): string[] {
  const images: string[] = []
  const add = (image: string | null): void => {
    if (image !== null && !images.includes(image)) {
      images.push(image)
    }
  }
  for (const source of sources) {
    if (source.kind === 'postgres') add(imageOf(source))
  }
  for (const source of sources) {
    if (source.kind !== 'postgres') add(imageOf(source))
  }
  add(ctx.config.image)
  for (const resource of ctx.store.listResources()) {
    if (resource.kind === 'postgres') add(imageOf(resource))
  }
  add(CADDY_IMAGE)
  add(NODE_IMAGE)
  return images
}

// Cheap to call: nothing touches Docker until a native operation is refused,
// and then the image is resolved once per TreeOps.
export function treeOpsFor(ctx: DaemonContext, sources: ImageSource[]): TreeOps {
  let elevated: ElevatedTreeOps | null = null
  const lazy: ElevatedTreeOps = {
    clone: (src, dst) => get().clone(src, dst),
    remove: (path) => get().remove(path),
  }
  function get(): ElevatedTreeOps {
    if (elevated === null) {
      const images = fallbackImages(ctx, sources)
      elevated = ctx.elevatedTreeOps?.(images) ?? createContainerTreeOps({ images })
    }
    return elevated
  }
  return {
    clone: (src, dst) => copyTree(src, dst, { elevated: lazy }),
    remove: (path) => removeTree(path, { elevated: lazy }),
  }
}
