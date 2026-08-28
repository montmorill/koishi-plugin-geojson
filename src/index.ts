import type { GeoJSON } from 'geojson'
import type { ScreenDims } from 'geojson2svg'
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

function resolveViewport({ width, height }: Partial<ScreenDims> = {}): ScreenDims {
  return {
    width: width ?? 640,
    height: height ?? 480,
  }
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
      const viewport = resolveViewport(options)
      const [west, south, east, north] = geojsonBbox(geojson)
      const mercator = { width: east - west, height: north - south }
      const mercatorRatio = mercator.width / mercator.height
      const viewportRatio = viewport.width / viewport.height
      const delta = mercator.width / Math.min(1, viewportRatio)
        - mercator.height * Math.max(1, viewportRatio)
      const dx = Math.max(-delta, 0) / 2
      const dy = -Math.max(delta, 0) / 2
      const converter = new GeoJSON2SVG({ viewportSize: viewport, attributes })
      const svgPaths = converter.convert(geojson, {
        coordinateConverter: ([x, y]) => [x + dx, y + dy],
      }).flatMap(h.parse)
      const zoomRatio = mercatorRatio / viewportRatio
      const elements = options?.graph ? [...svgPaths] : []
      svgPaths.forEach((path) => {
        path.attrs.fill = config.palette[path.attrs.dataColorId - 1]
        if (options?.dot || options?.label) {
          let [cx, cy]: [number, number] = [path.attrs.dataLon, path.attrs.dataLat];
          [cx, cy] = reproject({ type: 'Point', coordinates: [cx, cy] }).coordinates
          cx = remap(cx + dx - west, 0, mercator.width, 0, viewport.width * Math.min(1, zoomRatio))
          cy = remap(cy + dy - south, 0, mercator.height, viewport.height / Math.max(1, zoomRatio), 0)
          options?.dot && elements.push(h('circle', { cx, cy, r: options.dot, fill: 'black' }))
          options?.label && elements.push(h('text', { x: cx, y: cy }, path.attrs.dataName))
        }
      })
      return h('html', h('svg', viewport, ...elements))
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
