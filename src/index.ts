import type { GeoJSON } from 'geojson'
import type { Options, ScreenDims } from 'geojson2svg'
import type { Context } from 'koishi'
import { GeoJSON2SVG } from 'geojson2svg'
import geojsonBbox from 'geojson-bbox'
import { h, Schema } from 'koishi'
import reproject from 'reproject-spherical-mercator'

export const name = 'geojson'

export interface Config {
  defaultDot: number
  palette: string[]
}

export const Config: Schema<Config> = Schema.object({
  defaultDot: Schema.number().min(0).default(2),
  palette: Schema.array(Schema.string().role('color')).default([
    'rgba(236,  85, 158, 0.5)',
    'rgba(236, 133,  45, 0.5)',
    'rgba(136,  65, 220, 0.5)',
    'rgba(184, 228,  86, 0.5)',
    'rgba(55,   81, 169, 0.5)',
    'rgba(231, 122, 122, 0.5)',
  ]),
})

function resolveScreenDims(
  { width, height }: Partial<ScreenDims> = {},
  aspectRatio?: number,
): ScreenDims {
  if (!width)
    width = aspectRatio && height ? height * aspectRatio : 640
  if (!height)
    height = aspectRatio ? (width ?? 0) / aspectRatio : 480
  return { width, height }
}

export function apply(ctx: Context, config: Config) {
  async function resolveGeojson(data: string) {
    let geojson!: GeoJSON
    if (/^\d{2}$/.test(data))
      data = `https://dmfw.mca.gov.cn/js/map/subject/${data}.json`
    if (/^\d{4}$/.test(data))
      data = `https://dmfw.mca.gov.cn/js/map/subject/city/${data}.json`
    if (/^https?:\/\//.test(data))
      geojson = await ctx.http.get(data)
    return geojson ??= JSON.parse(data)
  }

  const attributes = [
    { type: 'dynamic', property: 'properties.TYPE', key: 'data-type' },
    { type: 'dynamic', property: 'properties.COLORID', key: 'data-color-id' },
    { type: 'dynamic', property: 'properties.XZQH', key: 'data-code' },
    { type: 'dynamic', property: 'properties.TSMC', key: 'data-name' },
    { type: 'dynamic', property: 'properties.X', key: 'data-lon' },
    { type: 'dynamic', property: 'properties.Y', key: 'data-lat' },
  ]

  ctx.command('geojson <data:string>')
    .option('width', '-W <width:posint>')
    .option('height', '-H <height:posint>')
    .option('graph', '-G')
    .option('dot', '-D [radius:number]')
    .option('label', '-L')
    .action(async ({ options }, data) => {
      if (options?.dot === 0)
        options.dot = config.defaultDot
      const geojson = reproject(await resolveGeojson(data))
      const [west, south, east, north] = geojsonBbox(geojson)
      const dataSize = { width: east - west, height: north - south }
      const dataAspectRatio = dataSize.width / dataSize.height
      const viewportSize = resolveScreenDims(options, dataAspectRatio)
      const viewAspectRatio = viewportSize.width / viewportSize.height
      const scaleFactor = dataAspectRatio / viewAspectRatio
      const contentWidth = viewportSize.width * Math.min(1, scaleFactor)
      const contentHeight = viewportSize.height / Math.max(1, scaleFactor)
      const delta = dataSize.width / Math.min(1, viewAspectRatio)
        - dataSize.height * Math.max(1, viewAspectRatio)
      const [dx, dy] = [Math.max(-delta, 0) / 2, -Math.max(delta, 0) / 2]
      const coordinateConverter: Options['coordinateConverter'] = ([x, y]) => [x + dx, y + dy]
      const converter = new GeoJSON2SVG({ viewportSize, attributes })
      const svgPaths = converter.convert(geojson, { coordinateConverter }).flatMap(h.parse)
      svgPaths.forEach(path => path.attrs.fill = config.palette[path.attrs.dataColorId - 1])
      const elements = options?.graph ? [...svgPaths] : []
      options?.dot && options?.label && svgPaths.forEach((path) => {
        let [cx, cy]: [number, number] = [path.attrs.dataLon, path.attrs.dataLat];
        [cx, cy] = reproject({ type: 'Point', coordinates: [cx, cy] }).coordinates
        cx = remap(cx + dx - west, 0, dataSize.width, 0, contentWidth)
        cy = remap(cy + dy - south, 0, dataSize.height, contentHeight, 0)
        options?.dot && elements.push(h('circle', { cx, cy, r: options.dot, fill: 'black' }))
        options?.label && elements.push(h('text', { x: cx, y: cy }, path.attrs.dataName))
      })
      return h('html', h('svg', viewportSize, ...elements))
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
