import type { ScreenDims } from '@montmorill/geojson2svg'
import type { FeatureCollection, GeoJSON } from 'geojson'
import type { Context } from 'koishi'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {} from '@koishijs/assets'
import { GeoJSON2SVG } from '@montmorill/geojson2svg'
import geojsonBbox from 'geojson-bbox'
import { h, Schema } from 'koishi'
import reproject from 'reproject-spherical-mercator'

export const name = 'geometry'

export interface Config {
  defaultArea: number
  defaultDot: number
  palette: string[]
}

export const Config: Schema<Config> = Schema.object({
  defaultArea: Schema.number().min(0).default(640 * 480),
  defaultDot: Schema.number().min(0).default(1),
  palette: Schema.array(Schema.string().role('color')).default([
    'rgba(236, 85, 158, 0.5)',
    'rgba(236, 133, 45, 0.5)',
    'rgba(136, 65, 220, 0.5)',
    'rgba(184, 228, 86, 0.5)',
    'rgba(55, 81, 169, 0.5)',
    'rgba(231, 122, 122, 0.5)',
  ]),
})

export async function apply(ctx: Context, config: Config) {
  function resolveScreenDims(
    aspectRatio: number,
    area = config.defaultArea,
  ): ScreenDims {
    const width = Math.sqrt(area * aspectRatio)
    const height = width / aspectRatio
    return { width, height }
  }

  const cacheDir = resolve(ctx.baseDir, 'cache', name)
  async function retrieveGeometry<T extends GeoJSON>(url: string): Promise<T> {
    const subjectPath = resolve(cacheDir, url.replaceAll('://', '/'))
    try {
      return await import(subjectPath)
    }
    catch {
      const data = await ctx.http.get(url)
      await mkdir(resolve(subjectPath, '..'), { recursive: true })
      await writeFile(subjectPath, JSON.stringify(data))
      return data
    }
  }

  const baseURL = 'https://dmfw.mca.gov.cn/js/map/subject'
  async function resolveGeometry(item: string): Promise<GeoJSON> {
    if (/^\d{2}$/.test(item) || item === 'china')
      return await retrieveGeometry(`${baseURL}/${item}.json`)
    if (/^\d{4}$/.test(item))
      return await retrieveGeometry(`${baseURL}/city/${item}.json`)
    if (/^\d{6}$/.test(item)) {
      return await retrieveGeometry<FeatureCollection>(`${baseURL}/city/${item.slice(0, 4)}.json`)
        .then((collection) => {
          collection.features = collection.features
            .filter(({ properties }) => item === properties!.XZQH)
          return collection
        })
    }
    if (item.match('^https?://'))
      return await retrieveGeometry(item)
    throw new Error(`failed to resolve ${item}`)
  }

  async function resolveFeatureCollection(items: string[]): Promise<FeatureCollection> {
    const features = (await Promise.all(items.map(async (item) => {
      const geometry = await resolveGeometry(item)
      if (geometry.type === 'FeatureCollection')
        return geometry.features
      if (geometry.type === 'Feature')
        return [geometry]
      throw new Error(`geometry type ${geometry.type} is not supported.`)
    }))).flat()
    return { type: 'FeatureCollection', features }
  }

  ctx.command('geometry <items...:string>')
    .option('area', '-A <area:posint>')
    .option('scale', '-R <factor:posint>')
    .option('graph', '-G')
    .option('dot', '-D [radius:number]')
    .option('label', '-L')
    .option('code', '-C')
    .option('font-size', '-T [size:number]', { fallback: 8 })
    .option('no-reproject', '-P')
    .action(async ({ options = {} }, ...items) => {
      if (options.dot === 0)
        options.dot = config.defaultDot
      let collection = await resolveFeatureCollection(items)
      options['no-reproject'] || (collection = reproject(collection))
      const [west, south, east, north] = geojsonBbox(collection)
      const dataSize = { width: east - west, height: north - south }
      const dataAspectRatio = dataSize.width / dataSize.height
      const viewportSize = options.scale
        ? { width: dataSize.width / options.scale, height: dataSize.height / options.scale }
        : resolveScreenDims(dataAspectRatio, options.area)
      const viewAspectRatio = viewportSize.width / viewportSize.height
      const scaleFactor = dataAspectRatio / viewAspectRatio
      const contentWidth = viewportSize.width * Math.min(1, scaleFactor)
      const contentHeight = viewportSize.height / Math.max(1, scaleFactor)
      const converter = new GeoJSON2SVG({ viewportSize, attributes: true })
      const svgPaths = converter.convert(collection).flatMap(h.parse)
      const children: h[] = []
      options.graph && children.push(...svgPaths.map(({ attrs }) =>
        h('path', { ...attrs, fill: config.palette[attrs.COLORID - 1] })))
      if (options.dot || options.code || options.label) {
        children.push(...svgPaths.map(({ attrs: { d, ...props } }) => {
          let [x, y]: [number, number] = [props.X, props.Y];
          [x, y] = reproject({ type: 'Point', coordinates: [x, y] }).coordinates
          x = remap(x - west, 0, dataSize.width, 0, contentWidth)
          y = remap(y - south, 0, dataSize.height, contentHeight, 0)
          return h('g', props, [
            options.dot && h('circle', { cx: x, cy: y, r: options.dot, fill: 'black' }),
            options.code && h('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'hanging' }, props.XZQH),
            options.label && h('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'baseline' }, props.TSMC),
          ].filter(maybeElement => h.isElement(maybeElement)))
        }))
      }
      const content = h('svg', {
        'xmlns': 'http://www.w3.org/2000/svg',
        'font-size': options['font-size'],
        ...viewportSize,
      }, children)
      const filename = `${items.sort().join('+')}${Object.entries(options ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `.${key}${value === true ? '' : value}`)
        .join('')}.svg`
      const filePath = resolve(cacheDir, filename.replaceAll(':', ''))
      await mkdir(resolve(filePath, '..'), { recursive: true })
      await writeFile(filePath, content.toString())
      return h('html', content)
    })
}

function remap(
  x: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  clamp = false,
) {
  let ratio = (x - inMin) / (inMax - inMin)
  clamp && (ratio = Math.max(0, Math.min(1, ratio)))
  return outMin + (outMax - outMin) * ratio
}
