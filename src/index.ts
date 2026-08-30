import type { Feature, FeatureCollection, GeoJSON } from 'geojson'
import type { DynamicAttribute, ScreenDims } from 'geojson2svg'
import type { Context } from 'koishi'
import {} from '@koishijs/assets'
import { GeoJSON2SVG } from 'geojson2svg'
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

const attributes = [
  { type: 'dynamic', property: 'properties.TYPE' },
  { type: 'dynamic', property: 'properties.COLORID' },
  { type: 'dynamic', property: 'properties.XZQH' },
  { type: 'dynamic', property: 'properties.TSMC' },
  { type: 'dynamic', property: 'properties.X' },
  { type: 'dynamic', property: 'properties.Y' },
] as const satisfies DynamicAttribute[]

export function apply(ctx: Context, config: Config) {
  function resolveScreenDims(
    aspectRatio: number,
    area = config.defaultArea,
  ): ScreenDims {
    const width = Math.sqrt(area * aspectRatio)
    const height = width / aspectRatio
    return { width, height }
  }

  const baseURL = 'https://dmfw.mca.gov.cn/js/map/subject/'
  async function resolveGeometry(item: string): Promise<GeoJSON> {
    if (/^\d{2}$/.test(item))
      return await ctx.http.get(`${item}.json`, { baseURL })
    if (/^\d{4}$/.test(item))
      return await ctx.http.get(`city/${item}.json`, { baseURL })
    if (/^\d{6}$/.test(item)) {
      return await ctx.http.get(`city/${item.slice(0, 4)}.json`, { baseURL })
        .then((geojson: FeatureCollection) => {
          geojson.features = geojson.features
            .filter(({ properties }) => item === properties!.XZQH)
          return geojson
        })
    }
    throw new Error(`resolveGeometry: failed to parse ${item}`)
  }

  async function resolveFeatureCollection(items: number[]): Promise<FeatureCollection> {
    const features = (await Promise.all(items.map(async (item) => {
      const geometry = await resolveGeometry(String(item))
      if (geometry.type === 'FeatureCollection')
        return geometry.features
      if (geometry.type === 'Feature')
        return [geometry]
      return [<Feature>{
        type: 'Feature',
        id: item,
        geometry,
        properties: null,
      }]
    }))).flat()
    return { type: 'FeatureCollection', features }
  }

  ctx.command('geometry <items...:posint>')
    .option('area', '-A <area:posint>')
    .option('scale', '-R <factor:posint>')
    .option('graph', '-G')
    .option('dot', '-D [radius:number]')
    .option('code', '-C')
    .option('label', '-L')
    .action(async ({ options }, ...items) => {
      if (options?.dot === 0)
        options.dot = config.defaultDot
      const geojson = reproject(await resolveFeatureCollection(items))
      const [west, south, east, north] = geojsonBbox(geojson)
      const dataSize = { width: east - west, height: north - south }
      const dataAspectRatio = dataSize.width / dataSize.height
      const viewportSize = options?.scale
        ? { width: dataSize.width / options.scale, height: dataSize.height / options.scale }
        : resolveScreenDims(dataAspectRatio, options?.area)
      const viewAspectRatio = viewportSize.width / viewportSize.height
      const scaleFactor = dataAspectRatio / viewAspectRatio
      const contentWidth = viewportSize.width * Math.min(1, scaleFactor)
      const contentHeight = viewportSize.height / Math.max(1, scaleFactor)
      const converter = new GeoJSON2SVG({ viewportSize, attributes })
      const svgPaths = converter.convert(geojson).flatMap(h.parse)
      const children: h[] = []
      children.push(...svgPaths.map(({ attrs }) =>
        h('path', { ...attrs, fill: config.palette[attrs.COLORID - 1] })))
      if (options?.dot || options?.code || options?.label) {
        children.push(...svgPaths.map(({ attrs: { d, ...props } }) => {
          let [cx, cy]: [number, number] = [props.X, props.Y];
          [cx, cy] = reproject({ type: 'Point', coordinates: [cx, cy] }).coordinates
          cx = remap(cx - west, 0, dataSize.width, 0, contentWidth)
          cy = remap(cy - south, 0, dataSize.height, contentHeight, 0)
          return h('g', props, [
            options?.dot && h('circle', { cx, cy, r: options.dot, fill: 'black' }),
            options?.code && h('text', { x: cx, y: cy }, props.XZQH),
            options?.label && h('text', { x: cx, y: cy }, props.TSMC),
          ].filter(maybeElement => h.isElement(maybeElement)))
        }))
      }
      return h('html', h('svg', viewportSize, children))
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
